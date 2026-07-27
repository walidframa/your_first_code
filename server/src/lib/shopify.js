/**
 * Shopify Admin API client.
 *
 * Talks GraphQL rather than REST: the REST Admin API is legacy and Shopify has
 * been moving inventory operations to GraphQL, so the newer surface is the one
 * worth building against.
 *
 * The base URL is injectable so the sync logic can be tested against a stand-in
 * server rather than a live shop.
 */

export const SHOPIFY_API_VERSION = '2025-01';

/** Shopify's own throttling; worth one polite retry rather than failing a sale. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class ShopifyError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** myshopify.com host, with any scheme or path the user pasted stripped off. */
export function normaliseShopDomain(input) {
  const raw = String(input || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  if (!raw) return null;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw) ? raw : null;
}

export function createClient({ shopDomain, accessToken, baseUrl = null, fetchImpl = fetch }) {
  const domain = normaliseShopDomain(shopDomain);
  if (!baseUrl && !domain) throw new ShopifyError('That does not look like a myshopify.com address');
  if (!accessToken) throw new ShopifyError('An Admin API access token is needed');

  const endpoint = baseUrl
    ? `${baseUrl.replace(/\/$/, '')}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`
    : `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  async function graphql(query, variables = {}, { attempt = 0 } = {}) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new ShopifyError(`Could not reach Shopify: ${err.message}`, { retryable: true });
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < 2) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 500 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      return graphql(query, variables, { attempt: attempt + 1 });
    }

    if (res.status === 401 || res.status === 403) {
      throw new ShopifyError('Shopify rejected the access token — check it and its scopes', {
        status: res.status,
      });
    }
    if (!res.ok) {
      throw new ShopifyError(`Shopify returned ${res.status}`, {
        status: res.status,
        retryable: RETRYABLE_STATUS.has(res.status),
      });
    }

    const body = await res.json().catch(() => null);
    if (!body) throw new ShopifyError('Shopify sent a response that could not be read');

    // GraphQL reports failures in the body with a 200, so both need checking.
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new ShopifyError(body.errors.map((e) => e.message).join('; '));
    }
    return body.data;
  }

  return {
    endpoint,
    graphql,

    /** The shop's name, used to prove the credentials work. */
    async shopInfo() {
      const data = await graphql(`{ shop { name myshopifyDomain currencyCode } }`);
      return data.shop;
    },

    /**
     * Locations to hold stock against. A shop with several needs one chosen —
     * syncing the wrong one would move stock in a warehouse rather than the shop.
     */
    async locations() {
      const data = await graphql(`
        { locations(first: 50, includeInactive: false) { nodes { id name isActive } } }
      `);
      return data.locations.nodes;
    },

    /**
     * Every variant that carries stock, with its inventory item and the quantity
     * available at `locationId`. Paged, because a catalogue can be long.
     */
    async variants({ locationId, cursor = null, pageSize = 100 }) {
      const data = await graphql(
        `query Variants($cursor: String, $pageSize: Int!, $locationId: ID!) {
           productVariants(first: $pageSize, after: $cursor) {
             pageInfo { hasNextPage endCursor }
             nodes {
               id
               sku
               barcode
               displayName
               product { id title }
               inventoryItem {
                 id
                 tracked
                 inventoryLevel(locationId: $locationId) {
                   quantities(names: ["available"]) { name quantity }
                 }
               }
             }
           }
         }`,
        { cursor, pageSize, locationId },
      );

      const { nodes, pageInfo } = data.productVariants;
      return {
        cursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
        variants: nodes.map((v) => ({
          variantId: v.id,
          sku: v.sku || null,
          barcode: v.barcode || null,
          title: v.product?.title ? `${v.product.title} — ${v.displayName || ''}`.trim() : v.displayName,
          productId: v.product?.id || null,
          inventoryItemId: v.inventoryItem?.id || null,
          tracked: !!v.inventoryItem?.tracked,
          available: availableFrom(v.inventoryItem?.inventoryLevel),
        })),
      };
    },

    /** Current available quantities for specific inventory items. */
    async levelsFor({ locationId, inventoryItemIds }) {
      if (inventoryItemIds.length === 0) return new Map();
      const data = await graphql(
        `query Levels($ids: [ID!]!, $locationId: ID!) {
           nodes(ids: $ids) {
             ... on InventoryItem {
               id
               inventoryLevel(locationId: $locationId) {
                 quantities(names: ["available"]) { name quantity }
               }
             }
           }
         }`,
        { ids: inventoryItemIds, locationId },
      );

      const levels = new Map();
      for (const node of data.nodes || []) {
        if (!node?.id) continue;
        levels.set(node.id, availableFrom(node.inventoryLevel));
      }
      return levels;
    },

    /**
     * Set — not adjust — the available quantity.
     *
     * Setting an absolute figure is what makes the sync self-healing: if a push
     * is ever missed, the next one still lands the shop on the right number,
     * whereas a missed delta would be wrong for ever.
     */
    async setAvailable({ locationId, inventoryItemId, quantity }) {
      const data = await graphql(
        `mutation SetAvailable($input: InventorySetQuantitiesInput!) {
           inventorySetQuantities(input: $input) {
             userErrors { field message }
           }
         }`,
        {
          input: {
            name: 'available',
            reason: 'correction',
            // The shop is the authority here; do not fail on a concurrent edit.
            ignoreCompareQuantity: true,
            quantities: [{ inventoryItemId, locationId, quantity: Math.max(0, Math.round(quantity)) }],
          },
        },
      );

      const errors = data.inventorySetQuantities?.userErrors || [];
      if (errors.length) throw new ShopifyError(errors.map((e) => e.message).join('; '));
      return true;
    },
  };
}

function availableFrom(inventoryLevel) {
  const entry = inventoryLevel?.quantities?.find((q) => q.name === 'available');
  return entry ? Number(entry.quantity) : null;
}
