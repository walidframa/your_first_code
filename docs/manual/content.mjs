/**
 * What the manual says, as data.
 *
 * Text here, layout in render.mjs, pictures in capture.mjs — so a wording
 * change is a change to one string and not to a template full of markup, and
 * the Arabic sits beside the English rather than in a second file that drifts
 * out of step with it.
 *
 * `shot` names a picture from shots.mjs. A section with no shot is prose; a
 * shot that was skipped during capture simply does not appear, which is why
 * nothing here depends on a picture being there.
 */

export const BRAND = {
  product: 'XTech POS',
  tagline: { en: 'The till for a phone shop', ar: 'نظام نقاط البيع لمحلات الهواتف' },
  site: 'xtechpos.com',
};

/* ------------------------------------------------------------ the manual */

export const MANUAL = {
  title: { en: 'User Manual', ar: 'دليل المستخدم' },
  chapters: [
    {
      id: 'intro',
      heading: { en: 'What this is', ar: 'ما هذا البرنامج' },
      body: {
        en: [
          'XTech POS runs the counter and the back office of a phone shop from one screen. It sells, it keeps the stock straight, it remembers who owes you money, and it prices everything in dollars and pounds at once from a single rate you set each morning.',
          'It runs in a browser. There is nothing to install on the till, nothing to install on the office laptop, and nothing to keep in step between them — they are looking at the same shop. An update reaches every screen the next time it is opened.',
          'This manual shows every screen. If you only have ten minutes, read the Quick Start instead: it covers the four things somebody at the counter does all day.',
        ],
        ar: [
          'يدير XTech POS واجهة البيع والمكتب الخلفي لمحل الهواتف من شاشة واحدة. يبيع، ويضبط المخزون، ويتذكّر من له عليك دين، ويسعّر كل شيء بالدولار والليرة معاً اعتماداً على سعر صرف واحد تحدّده كل صباح.',
          'يعمل داخل المتصفح. لا شيء يُثبَّت على جهاز الكاشير، ولا على حاسوب المكتب، ولا شيء يحتاج إلى مزامنة بينهما — كلاهما ينظر إلى المحل نفسه. أي تحديث يصل إلى كل الشاشات عند فتحها في المرة التالية.',
          'يعرض هذا الدليل كل الشاشات. إن كان لديك عشر دقائق فقط، اقرأ دليل البدء السريع: يغطي الأمور الأربعة التي يفعلها من يقف خلف الكاشير طوال اليوم.',
        ],
      },
    },
    {
      id: 'signin',
      heading: { en: 'Signing in', ar: 'تسجيل الدخول' },
      shot: 'signin',
      body: {
        en: [
          'Every person who uses the shop has their own account. That is not bureaucracy: every sale, every refund and every price change is recorded against the name that made it, and a shop where everybody shares one login cannot answer the question "who did this?".',
          'The first time somebody signs in they are asked to choose their own password. They cannot reach anything until they do.',
        ],
        ar: [
          'لكل شخص يستخدم البرنامج حساب خاص به. هذا ليس تعقيداً: كل عملية بيع، وكل استرجاع، وكل تعديل سعر يُسجَّل باسم من قام به، والمحل الذي يتشارك فيه الجميع حساباً واحداً لا يمكنه الإجابة عن سؤال «من فعل هذا؟».',
          'في أول مرة يسجّل فيها أحدهم الدخول يُطلب منه اختيار كلمة سر خاصة به، ولا يمكنه الوصول إلى أي شيء قبل ذلك.',
        ],
      },
    },
    {
      id: 'register',
      heading: { en: 'The register', ar: 'شاشة البيع' },
      shot: 'register',
      body: {
        en: [
          'This is where the day happens. Scan a barcode and the line appears; there is no Add button to find and no field to click into first — the scanner types, and the till listens.',
          'No scanner? Tap the product on the grid. The filter bar across the top narrows it to one shelf, so a shop with two hundred lines is still two taps from a charger.',
        ],
        ar: [
          'هنا يجري اليوم. امسح الباركود فيظهر السطر مباشرة؛ لا يوجد زر «إضافة» تبحث عنه ولا حقل تضغط عليه أولاً — الماسح يكتب، والصندوق يسمع.',
          'لا يوجد ماسح؟ اضغط على المنتج في الشبكة. شريط التصنيفات في الأعلى يحصر العرض برفٍّ واحد، فيبقى المحل الذي يملك مئتي صنف على بعد ضغطتين من الشاحن.',
        ],
      },
    },
    {
      id: 'selling',
      heading: { en: 'Taking a payment', ar: 'قبض الثمن' },
      shot: 'register-cart',
      body: {
        en: [
          'The cart totals in dollars and in pounds at the same time, from the rate in Settings. You do not convert anything and neither does the cashier.',
          'A customer can pay in either currency, or in both — some dollars and the rest in pounds. Type what they actually handed over and the change is worked out for you, in the currency you have to give it back in.',
        ],
        ar: [
          'تُحتسب السلة بالدولار والليرة في الوقت نفسه، اعتماداً على السعر المحفوظ في الإعدادات. لا أنت تحوّل ولا الكاشير يحوّل.',
          'يمكن للزبون أن يدفع بأي من العملتين أو بهما معاً — جزء بالدولار والباقي بالليرة. أدخل ما دفعه فعلاً، فيُحسب الباقي له بالعملة التي عليك أن تعيدها بها.',
        ],
      },
      steps: {
        en: [
          'Scan or tap what they are buying.',
          'Apply a discount if you agreed one — as a percentage, in dollars, or in pounds.',
          'Press Pay, enter what they handed you, and hand back the change shown.',
          'Print the receipt, or send it on WhatsApp.',
        ],
        ar: [
          'امسح أو اضغط ما يشتريه الزبون.',
          'طبّق الحسم إن اتفقتم عليه — نسبة مئوية، أو مبلغاً بالدولار، أو بالليرة.',
          'اضغط «دفع»، أدخل ما سلّمه لك، وأعد له الباقي الظاهر على الشاشة.',
          'اطبع الفاتورة أو أرسلها عبر واتساب.',
        ],
      },
    },
    {
      id: 'menu',
      heading: { en: 'Getting around', ar: 'التنقّل' },
      shot: 'menu',
      body: {
        en: [
          'Two ways to reach every screen. Down the left is a list for a mouse; the Menu button opens the same screens as large tiles, which is what you want on a touch screen where a thin list is a thin target.',
          'On the register the side list is hidden on purpose. That screen needs its width for products, and on a square monitor every column matters.',
        ],
        ar: [
          'طريقتان للوصول إلى كل شاشة. على اليسار قائمة مناسبة للفأرة؛ وزر «القائمة» يفتح الشاشات نفسها على شكل أيقونات كبيرة، وهو ما تحتاجه على شاشة اللمس حيث تكون القائمة الرفيعة هدفاً رفيعاً.',
          'في شاشة البيع تُخفى القائمة الجانبية عمداً. تلك الشاشة تحتاج عرضها للمنتجات، وعلى شاشة مربّعة يهمّ كل عمود.',
        ],
      },
    },
    {
      id: 'products',
      heading: { en: 'The catalogue', ar: 'قائمة المنتجات' },
      shot: 'products',
      body: {
        en: [
          'Everything you sell, with its selling price and what it cost you. The cost is what makes the profit screen possible, so a shop that leaves it blank gets a profit figure that is really a sales figure.',
          'A product can carry more than one barcode. The same charger arriving from two suppliers in two boxes still scans as one line of stock rather than becoming two products that each look half sold.',
        ],
        ar: [
          'كل ما تبيعه، مع سعر البيع والكلفة التي دفعتها. الكلفة هي ما يجعل شاشة الأرباح ممكنة، فالمحل الذي يتركها فارغة يحصل على رقم أرباح هو في الحقيقة رقم مبيعات.',
          'يمكن للمنتج الواحد أن يحمل أكثر من باركود. الشاحن نفسه الوارد من مورّدين في علبتين يبقى سطر مخزون واحداً بدل أن يصبح منتجين يبدو كل منهما نصف مبيع.',
        ],
      },
    },
    {
      id: 'inventory',
      heading: { en: 'Stock', ar: 'المخزون' },
      shot: 'inventory',
      body: {
        en: [
          'What is on the shelf, and what is about to run out. Each product has a reorder point; anything at or below it is flagged, so the list doubles as the order you place with your supplier.',
          'Stock moves on its own as you sell. You count it by hand only when the shelf and the screen disagree — and when you correct it, the correction is recorded with your name and the reason, because unexplained stock changes are how shops lose things quietly.',
        ],
        ar: [
          'ما هو موجود على الرف، وما أوشك على النفاد. لكل منتج حدّ إعادة طلب؛ وكل ما بلغه أو نزل تحته يُعلَّم، فتصبح القائمة نفسها هي الطلبية التي ترسلها إلى المورّد.',
          'يتحرّك المخزون تلقائياً مع كل عملية بيع. لا تعدّه يدوياً إلا حين يختلف الرف مع الشاشة — وعند التصحيح يُسجَّل التعديل باسمك وبسببه، لأن تغيّر المخزون بلا تفسير هو الطريقة التي تضيع بها البضاعة بهدوء.',
        ],
      },
    },
    {
      id: 'customers',
      heading: { en: 'Customers and credit', ar: 'الزبائن والذمم' },
      shot: 'customers',
      body: {
        en: [
          'Who owes you money, and how much. A sale can go out unpaid or part paid against a customer, and what is outstanding follows them until it is settled.',
          'Each customer can be given a credit limit, so the till refuses a debt you did not agree to rather than leaving it to whoever is on the counter to argue about.',
        ],
        ar: [
          'من له عليك دين وكم. يمكن أن تخرج الفاتورة غير مدفوعة أو مدفوعة جزئياً على حساب زبون، ويبقى الرصيد المتبقّي مرتبطاً به حتى يُسدَّد.',
          'يمكن تحديد سقف دين لكل زبون، فيرفض الصندوق ديناً لم توافق عليه بدل أن يترك الأمر لمن يقف خلف الكاشير ليتجادل فيه.',
        ],
      },
    },
    {
      id: 'repairs',
      heading: { en: 'Repairs', ar: 'التصليحات' },
      shot: 'repairs',
      body: {
        en: [
          'A phone comes in broken. You write down whose it is, what is wrong with it, and what you expect to charge; the customer gets a ticket with a code on it.',
          'Parts used on the repair come out of your stock, so a screen fitted to somebody\'s phone leaves the shelf the same way a screen sold over the counter does.',
        ],
        ar: [
          'يصل هاتف معطّل. تسجّل صاحبه، والعطل، والمبلغ المتوقّع؛ ويأخذ الزبون إيصالاً عليه رمز.',
          'القطع المستخدمة في التصليح تُخصم من مخزونك، فالشاشة التي تُركَّب على هاتف زبون تغادر الرف تماماً كالشاشة التي تُباع على الكاشير.',
        ],
      },
    },
    {
      id: 'tradeins',
      heading: { en: 'Trade-ins', ar: 'الاستبدال' },
      shot: 'trade-ins',
      body: {
        en: [
          'A customer brings an old phone against a new one. You record what you are giving them for it, and their identity card is photographed and kept with the record — from the webcam on the counter PC, or from a file if you already have one.',
          'The money can go either way and the screen says which. If their old phone is worth more than the one they are taking, you owe them the difference, and it says so rather than showing a negative number to be interpreted.',
        ],
        ar: [
          'يحضر الزبون هاتفاً قديماً مقابل جديد. تسجّل المبلغ الذي تعطيه له، وتُصوَّر هويته وتُحفظ مع السجل — من كاميرا جهاز الكاشير، أو من ملف إن كانت الصورة جاهزة.',
          'قد يكون المبلغ لك أو عليك، والشاشة تقول أيّهما. إذا كان هاتفه القديم أغلى من الذي يأخذه فالفرق له عليك، وتقول الشاشة ذلك بدل أن تعرض رقماً سالباً يحتاج إلى تفسير.',
        ],
      },
    },
    {
      id: 'cashbox',
      heading: { en: 'The drawer', ar: 'الصندوق' },
      shot: 'cashbox',
      body: {
        en: [
          'What should be in the till right now, in both currencies, and everything that went in or out today. Money paid out — a supplier at the door, a delivery, petrol — is entered here so the drawer and the screen still agree at the end of the day.',
          'Close the day and you get a printable summary: what was sold, what was taken in cash, what went out, and what should be left to count.',
        ],
        ar: [
          'ما يجب أن يكون في الصندوق الآن بالعملتين، وكل ما دخل أو خرج اليوم. المبالغ المدفوعة — مورّد على الباب، توصيلة، بنزين — تُدخَل من هنا ليبقى الصندوق متطابقاً مع الشاشة في آخر النهار.',
          'أقفل اليوم فتحصل على ملخّص قابل للطباعة: ما بيع، وما قُبض نقداً، وما خرج، وما يجب أن يبقى لتعدّه.',
        ],
      },
    },
    {
      id: 'profit',
      heading: { en: 'Profit', ar: 'الأرباح' },
      shot: 'profit',
      body: {
        en: [
          'What you actually made, not what you turned over. Sales minus the cost of what you sold, over whatever period you choose, broken down so you can see which shelf earns and which one only looks busy.',
          'This screen is worth exactly as much as the cost prices in your catalogue. Keep those honest and it is the most useful screen in the app.',
        ],
        ar: [
          'ما ربحته فعلاً، لا ما بعته. المبيعات ناقص كلفة ما بيع، خلال الفترة التي تختارها، موزّعة لترى أي رفّ يربح وأيّهما يبدو مشغولاً فقط.',
          'قيمة هذه الشاشة من قيمة أسعار الكلفة في قائمتك. حافظ على صحّتها تكن أنفع شاشة في البرنامج.',
        ],
      },
    },
    {
      id: 'documents',
      heading: { en: 'Quotations and invoices', ar: 'عروض الأسعار والفواتير' },
      shot: 'documents',
      body: {
        en: [
          'A written quotation for a customer deciding, and a proper invoice for one who has decided. Both print, both carry your shop name and details, and both can go out on WhatsApp instead of on paper.',
          'A quotation that turns into a sale does not have to be typed twice.',
        ],
        ar: [
          'عرض سعر مكتوب للزبون الذي ما زال يفكّر، وفاتورة رسمية لمن قرّر. كلاهما يُطبع، وكلاهما يحمل اسم محلك وبياناته، وكلاهما يمكن أن يُرسل عبر واتساب بدل الورق.',
          'عرض السعر الذي يتحوّل إلى بيع لا يحتاج إلى إدخاله مرتين.',
        ],
      },
    },
    {
      id: 'branches',
      heading: { en: 'More than one shop', ar: 'أكثر من فرع' },
      shot: 'branches',
      body: {
        en: [
          'Each branch has its own stock and its own drawer. Sales, cash and reports are all counted per branch, so one shop having a good week does not hide another having a bad one.',
          'Stock moves between them as a transfer that both ends see: sent from one, received at the other, and nothing goes missing in the gap.',
        ],
        ar: [
          'لكل فرع مخزونه وصندوقه. المبيعات والنقد والتقارير تُحتسب لكل فرع على حدة، فلا يخفي أسبوع جيّد في فرع أسبوعاً سيئاً في آخر.',
          'تنتقل البضاعة بينهما كتحويل يراه الطرفان: يُرسَل من هنا ويُستلَم هناك، ولا يضيع شيء في الطريق.',
        ],
      },
    },
    {
      id: 'staff',
      heading: { en: 'Staff and permissions', ar: 'الموظفون والصلاحيات' },
      shot: 'staff',
      body: {
        en: [
          'Give each person an account and tick what they may do. A cashier who should sell but not see your profit, or change a price, or open the settings, is a few ticks — not a matter of trust and hoping.',
          'Somebody who leaves is switched off here. Their sales stay in the record; their way in does not.',
        ],
        ar: [
          'أعطِ كل شخص حساباً وحدّد ما يُسمح له به. الكاشير الذي يجب أن يبيع دون أن يرى أرباحك أو يغيّر سعراً أو يفتح الإعدادات هو بضع علامات — لا مسألة ثقة ورجاء.',
          'من يترك العمل يُوقَف حسابه من هنا. تبقى مبيعاته في السجل، ويزول دخوله.',
        ],
      },
    },
    {
      id: 'settings',
      heading: { en: 'Settings', ar: 'الإعدادات' },
      shot: 'settings',
      body: {
        en: [
          'Your shop name and details, which appear on every receipt and invoice. The exchange rate, which is the one number to update each morning and the only place pounds are calculated from. Tax, which is off until you turn it on and set your own rate.',
          'Backups live here too. The whole shop is one file; take a copy before anything you are unsure about, and keep one somewhere that is not this computer.',
        ],
        ar: [
          'اسم محلك وبياناته، وتظهر على كل فاتورة. وسعر الصرف، وهو الرقم الوحيد الذي تحدّثه كل صباح والمصدر الوحيد لحساب الليرة. والضريبة، وهي مطفأة حتى تشغّلها وتحدّد نسبتك.',
          'النسخ الاحتياطية هنا أيضاً. المحل كله ملف واحد؛ خذ نسخة قبل أي شيء لست واثقاً منه، واحتفظ بواحدة في مكان غير هذا الحاسوب.',
        ],
      },
    },
    {
      id: 'offline',
      heading: { en: 'When the internet goes', ar: 'عند انقطاع الإنترنت' },
      body: {
        en: [
          'The till keeps selling. Sales made while the connection is down are held on the device and sent up when it returns, and they are counted once — not once now and again later.',
          'What you cannot do while it is down is anything that needs the server to answer: reports, and looking a customer up. Selling, which is the thing you cannot postpone, carries on.',
        ],
        ar: [
          'يستمر الصندوق بالبيع. المبيعات التي تتم أثناء انقطاع الاتصال تُحفظ على الجهاز وتُرسل عند عودته، وتُحتسب مرة واحدة — لا مرة الآن ومرة لاحقاً.',
          'ما لا يمكنك فعله أثناء الانقطاع هو ما يحتاج جواباً من الخادم: التقارير والبحث عن زبون. أما البيع، وهو ما لا يمكن تأجيله، فيستمر.',
        ],
      },
    },
  ],
};

/* --------------------------------------------------------- the quick start */

export const QUICKSTART = {
  title: { en: 'Quick Start', ar: 'دليل البدء السريع' },
  subtitle: {
    en: 'The four things you do all day. Everything else is in the manual.',
    ar: 'الأمور الأربعة التي تفعلها طوال اليوم. وما عداها في الدليل الكامل.',
  },
  chapters: [
    {
      id: 'qs-signin',
      heading: { en: '1 — Sign in', ar: '١ — سجّل الدخول' },
      shot: 'signin',
      body: {
        en: [
          'Your own name and your own password. The first time, you choose a new password before anything else opens.',
        ],
        ar: ['باسمك أنت وكلمة سرّك أنت. في المرة الأولى تختار كلمة سر جديدة قبل أن يُفتح أي شيء.'],
      },
    },
    {
      id: 'qs-sell',
      heading: { en: '2 — Sell something', ar: '٢ — بِع' },
      shot: 'register-cart',
      steps: {
        en: [
          'Scan the barcode, or tap the product.',
          'Wrong quantity? Change it on the line. Wrong item? Remove the line.',
          'Press Pay.',
        ],
        ar: [
          'امسح الباركود أو اضغط على المنتج.',
          'الكمية خطأ؟ عدّلها على السطر. الصنف خطأ؟ احذف السطر.',
          'اضغط «دفع».',
        ],
      },
    },
    {
      id: 'qs-pay',
      heading: { en: '3 — Take the money', ar: '٣ — اقبض' },
      body: {
        en: [
          'Type what the customer actually handed you — dollars, pounds, or some of each. The change is worked out and shown in the currency you give back.',
          'Then print the receipt or send it on WhatsApp.',
        ],
        ar: [
          'أدخل ما سلّمك إياه الزبون فعلاً — دولاراً أو ليرة أو الاثنين معاً. يُحسب الباقي ويظهر بالعملة التي ستعيدها.',
          'ثم اطبع الفاتورة أو أرسلها عبر واتساب.',
        ],
      },
    },
    {
      id: 'qs-close',
      heading: { en: '4 — Close the day', ar: '٤ — أقفل اليوم' },
      shot: 'cashbox',
      body: {
        en: [
          'Open the Cashbox. It says what should be in the drawer. Count what is there. If they differ, say so now rather than tomorrow — the difference is findable today and a mystery next week.',
        ],
        ar: [
          'افتح «الصندوق». يقول لك ما يجب أن يكون فيه. عُدّ ما هو موجود. إن اختلفا فقل ذلك اليوم لا غداً — الفرق يمكن إيجاده اليوم ويصبح لغزاً بعد أسبوع.',
        ],
      },
    },
    {
      id: 'qs-rules',
      heading: { en: 'Two rules', ar: 'قاعدتان' },
      body: {
        en: [
          'Never share your login. Everything is recorded under the name that did it, and that protects you as much as it protects the shop.',
          'If the screen and the shelf disagree, tell the owner. Do not quietly adjust the number to match.',
        ],
        ar: [
          'لا تشارك حسابك مع أحد. كل شيء يُسجَّل باسم من قام به، وهذا يحميك بقدر ما يحمي المحل.',
          'إذا اختلفت الشاشة مع الرف فأبلغ صاحب المحل. لا تعدّل الرقم بهدوء ليتطابق.',
        ],
      },
    },
  ],
};
