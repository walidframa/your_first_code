/**
 * A stand-in Shopify.
 *
 * The whole point of the sync is what happens between two systems, so testing
 * it against a mocked-out client would test almost nothing. This is a real HTTP
 * server speaking the same GraphQL shapes the Admin API does, holding real
 * inventory that both sides can move — so "sold on Shopify" in a test means the
 * number here changed, and the sync has to notice.
 */
import http from 'node:http';

export function createFakeShopify({ token = 'test-token' } = {}) {
  const state = {
    shopName: 'Test Shop',
    locationId: 'gid://shopify/Location/1',
    variants: [],
    // Set to make the next call fail, so retries and backoff can be exercised.
    failNext: 0,
    requests: 0,
  };

  const addVariant = ({ sku, barcode = null, title = sku, available = 0 }) => {
    const n = state.variants.length + 1;
    const variant = {
      variantId: `gid://shopify/ProductVariant/${n}`,
      inventoryItemId: `gid://shopify/InventoryItem/${n}`,
      productId: `gid://shopify/Product/${n}`,
      sku,
      barcode,
      title,
      available,
      tracked: true,
    };
    state.variants.push(variant);
    return variant;
  };

  const find = (inventoryItemId) => state.variants.find((v) => v.inventoryItemId === inventoryItemId);

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      state.requests += 1;

      const reply = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.headers['x-shopify-access-token'] !== token) {
        return reply(401, { errors: [{ message: 'Invalid API key or access token' }] });
      }
      if (state.failNext > 0) {
        state.failNext -= 1;
        return reply(503, { errors: [{ message: 'Service unavailable' }] });
      }

      const { query, variables } = JSON.parse(body || '{}');

      if (query.includes('shop {')) {
        return reply(200, {
          data: { shop: { name: state.shopName, myshopifyDomain: 'test.myshopify.com', currencyCode: 'USD' } },
        });
      }

      if (query.includes('locations(')) {
        return reply(200, {
          data: { locations: { nodes: [{ id: state.locationId, name: 'Main Shop', isActive: true }] } },
        });
      }

      if (query.includes('productVariants(')) {
        return reply(200, {
          data: {
            productVariants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: state.variants.map((v) => ({
                id: v.variantId,
                sku: v.sku,
                barcode: v.barcode,
                displayName: v.title,
                product: { id: v.productId, title: v.title },
                inventoryItem: {
                  id: v.inventoryItemId,
                  tracked: v.tracked,
                  inventoryLevel: { quantities: [{ name: 'available', quantity: v.available }] },
                },
              })),
            },
          },
        });
      }

      if (query.includes('nodes(ids:')) {
        return reply(200, {
          data: {
            nodes: (variables.ids || []).map((id) => {
              const variant = find(id);
              return variant
                ? {
                    id,
                    inventoryLevel: { quantities: [{ name: 'available', quantity: variant.available }] },
                  }
                : null;
            }),
          },
        });
      }

      if (query.includes('inventorySetQuantities')) {
        const [entry] = variables.input.quantities;
        const variant = find(entry.inventoryItemId);
        if (!variant) {
          return reply(200, {
            data: { inventorySetQuantities: { userErrors: [{ message: 'No such inventory item' }] } },
          });
        }
        variant.available = entry.quantity;
        return reply(200, { data: { inventorySetQuantities: { userErrors: [] } } });
      }

      return reply(200, { errors: [{ message: `Unhandled query: ${query.slice(0, 60)}` }] });
    });
  });

  return {
    state,
    addVariant,
    /** Move stock the way a Shopify order would. */
    sellOnShopify(sku, quantity) {
      const variant = state.variants.find((v) => v.sku === sku);
      variant.available -= quantity;
      return variant.available;
    },
    quantityOf(sku) {
      return state.variants.find((v) => v.sku === sku)?.available;
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
