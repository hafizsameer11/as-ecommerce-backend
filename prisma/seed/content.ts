/**
 * CMS content seeded from the copy hard-coded in asl-web today (customer-care pages, /how-it-works,
 * /concierge-service, FAQ data) — idempotent: existing pages / categories / questions are never overwritten,
 * so staff edits survive a re-seed.
 *
 * Single source of truth: business values (return window, refund days, delivery fees + times, free-shipping
 * threshold, damaged-item window, support hours, contact details, payment methods) are NOT copied as text.
 * They are template tokens rendered from settings / shipping zones when the page is requested, e.g.
 *   {{returns.windowDays}} · {{returns.refundProcessingDays}} · {{shipping.deliveryFeesTable}} · {{profile.supportEmail}}
 * Where the old copy contradicted docs/DECISIONS.md, the backend value wins (listed in the module report).
 */
import type { PrismaClient } from "../../src/generated/prisma/client";

type Item = { title?: string; body?: string; icon?: string; value?: string; href?: string; imageUrl?: string };
type Block = Record<string, unknown> & { type: string };

const hero = (title: string, body?: string, extra: Partial<Block> = {}): Block => ({ type: "hero", title, ...(body ? { body } : {}), ...extra });
const rich = (title: string | undefined, body: string, extra: Partial<Block> = {}): Block => ({ type: "rich_text", ...(title ? { title } : {}), body, ...extra });
const cols = (items: Item[], extra: Partial<Block> = {}): Block => ({ type: "columns", items, ...extra });
const cta = (ctaLabel: string, ctaHref: string, extra: Partial<Block> = {}): Block => ({ type: "cta", ctaLabel, ctaHref, ...extra });
const note = (title: string, body: string, icon = "ShieldCheck"): Block => rich(title, body, { variant: "note", icon });

/** Email / Phone / Address cards at the bottom of the legal pages */
const contactCards = cols(
  [
    { title: "Email", value: "{{profile.supportEmail}}", icon: "Mail", href: "mailto:{{profile.supportEmail}}" },
    { title: "Phone / WhatsApp", value: "{{profile.whatsapp}}", icon: "Phone" },
    { title: "Address", value: "{{profile.address}}", icon: "MapPin" },
  ],
  { variant: "contact" },
);

const sectionList = (sections: [string, string, string][]) => cols(sections.map(([icon, title, body]) => ({ icon, title, body: `<p>${body}</p>` })), { variant: "list" });

type PageSeed = {
  slug: string;
  title: string;
  template: "standard" | "legal" | "landing" | "story" | "help";
  subtitle?: string;
  seoTitle: string;
  seoDescription: string;
  showInHeader?: boolean;
  showInFooter?: boolean;
  tags: string[];
  blocks: Block[];
};

const PAGES: PageSeed[] = [
  {
    slug: "customer-care/about-us",
    title: "About Us",
    template: "story",
    seoTitle: "About Us",
    seoDescription: "ASL ORIGINALS - Authentic. Curated. Trusted. A premium fashion destination for those who value quality and timeless style.",
    showInHeader: true,
    showInFooter: true,
    tags: ["brand"],
    blocks: [
      hero("Luxury", "A world of authentic luxury, defined by exceptional quality and considered curation.", {
        eyebrow: "Est. Lagos - Worldwide", ctaLabel: "Discover Our Story", ctaHref: "#our-story", alt: "Inside the ASL ORIGINALS boutique",
      }),
      rich("About Us", [
        "<p><strong>AUTHENTIC. CURATED. TRUSTED.</strong></p>",
        "<p>ASL ORIGINALS is a premium destination for authentic luxury fashion, offering carefully curated clothing, footwear, accessories, fragrances, and timepieces from trusted global retailers and verified suppliers.</p>",
        "<p>Every product is selected with authenticity, quality, and craftsmanship in mind, delivering a shopping experience built on trust, confidence, and exceptional service for customers worldwide.</p>",
      ].join(""), { eyebrow: "About ASL ORIGINALS" }),
      cols([
        { value: "01", title: "The Beginning", body: "<p>ASL ORIGINALS was created to give customers a trusted place to shop authentic luxury fashion without compromise. We believe buying genuine products should be simple, secure, and worry free.</p>" },
        { value: "02", title: "Our Sourcing", body: "<p>Every product is carefully sourced from trusted retailers, official brand stores, and verified suppliers across leading luxury markets, including the United Kingdom, Italy, France, the United States, Japan, and other established global fashion destinations. Every item is selected with authenticity, quality, and craftsmanship as our highest priorities.</p>" },
        { value: "03", title: "Our Promise", body: "<p>We promise to deliver only authentic products, backed by trusted sourcing, honest service, and a premium shopping experience. Every order reflects our commitment to quality, trust, and customer satisfaction.</p>" },
      ], { eyebrow: "Our Story", variant: "chapters", id: "our-story" }),
      cols([
        { title: "Mission", body: "<p>To make authentic luxury fashion accessible through trusted sourcing, genuine products, and exceptional service, inspiring confidence with every purchase.</p>" },
        { title: "Vision", body: "<p>To be the world's most trusted destination for authentic luxury fashion, setting the global standard for trust, quality, and customer experience.</p>" },
      ], { variant: "mission" }),
      cols([
        { title: "Authenticity", body: "<p>We are committed to offering only genuine products sourced through trusted and verified channels.</p>" },
        { title: "Curation", body: "<p>We thoughtfully curate every collection, selecting authentic products that meet our standards for quality, craftsmanship, and timeless style.</p>" },
        { title: "Trust", body: "<p>We build lasting relationships through honesty, transparency, and reliability.</p>" },
        { title: "Quality", body: "<p>We carefully select every product to meet the highest standards of authenticity and craftsmanship.</p>" },
        { title: "Excellence", body: "<p>We strive for excellence in every detail, from sourcing to customer service.</p>" },
        { title: "Customer First", body: "<p>Our customers are at the heart of everything we do, and their satisfaction is our highest priority.</p>" },
        { title: "Service", body: "<p>We are dedicated to providing exceptional service that makes every shopping experience simple, seamless, and memorable.</p>" },
      ], { eyebrow: "Our Values", variant: "values" }),
      cols([
        { icon: "ShoppingBag", value: "10,000+", title: "Happy Clients" },
        { icon: "Package", value: "5,000+", title: "Pieces Delivered" },
        { icon: "Globe2", value: "100%", title: "Authentic" },
        { icon: "Star", value: "4.9/5", title: "Client Rating" },
      ], { variant: "stats" }),
      cta("Shop The Collection", "/shop", {
        title: "Why Shop With Us?",
        body: "<p>We don't just sell products - we deliver confidence. Choosing ASL ORIGINALS means choosing authenticity, quality, and a house that values you.</p>",
        // old copy: "Easy returns and exchanges." — exchanges are only for defective items (returns.exchangesOnlyForDefective)
        items: [
          { title: "Carefully curated collections." },
          { title: "Fast and reliable delivery." },
          { title: "Dedicated concierge support." },
          { title: "Easy returns within {{returns.windowDays}} days of delivery." },
        ],
      }),
    ],
  },
  {
    slug: "customer-care/our-commitment",
    title: "Our Commitment",
    template: "story",
    subtitle: "At ASL ORIGINALS, every decision we make is guided by our commitment to authenticity, quality, transparency, and customer satisfaction.",
    seoTitle: "Our Commitment",
    seoDescription: "Our commitment to authenticity, quality, transparency, and customer satisfaction.",
    showInFooter: true,
    tags: ["brand"],
    blocks: [
      hero("Our Commitment", "At ASL ORIGINALS, every decision we make is guided by our commitment to authenticity, quality, transparency, and customer satisfaction."),
      rich(undefined, "<p>We believe shopping for premium fashion should be simple, secure, and trustworthy. From the moment you browse our collections until your order arrives, our goal is to provide an exceptional experience.</p>"),
      sectionList([
        ["Award", "Authentic Products", "We source every product from trusted suppliers and carefully inspect each item before it is made available for sale. Our commitment is to provide only genuine products that meet our quality standards."],
        ["Diamond", "Premium Quality", "We carefully curate every collection to ensure our customers receive premium products from respected global brands. Quality is at the core of everything we offer."],
        ["Users", "Customer Satisfaction", "Our customers are our priority. We are committed to providing responsive support, clear communication, and professional service before, during, and after every purchase."],
        ["Lock", "Secure Shopping", "Your privacy and payment information are protected using secure payment technology and encrypted checkout systems. You can shop with confidence knowing your information is handled responsibly."],
        ["Truck", "Reliable Delivery", "Every order is carefully prepared and packaged before dispatch. We work with trusted delivery partners to ensure your order arrives safely and within the estimated delivery timeframe whenever possible."],
        ["FileCheck", "Fair Policies", "Our Shipping Policy, Return Policy, Refund Policy, Privacy Policy, and Terms of Service are designed to provide a transparent and fair shopping experience for every customer."],
        ["TrendingUp", "Continuous Improvement", "We are always looking for ways to improve our website, collections, customer service, and overall shopping experience. Your feedback helps us grow and serve you better."],
      ]),
      cols([
        { icon: "ShieldCheck", title: "100% Authentic Products" },
        { icon: "Sparkles", title: "Carefully Curated Collections" },
        { icon: "Lock", title: "Secure Payments" },
        { icon: "Truck", title: "Reliable Delivery" },
        { icon: "FileCheck", title: "Transparent Policies" },
        { icon: "Headphones", title: "Dedicated Customer Support" },
        { icon: "Star", title: "A Premium Shopping Experience" },
      ], { title: "Our Promise", body: "<p>When you shop with ASL ORIGINALS, you can expect:</p>", variant: "checklist", icon: "Star" }),
      note("Thank You", "<p>Thank you for choosing ASL ORIGINALS. Your trust inspires us to continue delivering authenticity, quality, and exceptional service with every order.</p>", "ShoppingBag"),
    ],
  },
  {
    slug: "customer-care/how-it-works",
    title: "How It Works",
    template: "help",
    subtitle: "Shopping with ASL ORIGINALS is simple, secure, and designed for you.",
    seoTitle: "How It Works",
    seoDescription: "Simple, secure shopping with ASL ORIGINALS - from browsing to delivery in 7 easy steps.",
    showInFooter: true,
    tags: ["help"],
    blocks: [
      hero("How It Works", "Shopping with ASL ORIGINALS is simple, secure, and designed for you."),
      rich(undefined, "<p>Follow these simple steps from browsing to delivery.</p>"),
      cols([
        { icon: "ShoppingBag", title: "Browse & Shop", body: "<p>Explore our latest collections and add your favourite items to the cart.</p>" },
        { icon: "ShoppingCart", title: "Add to Cart", body: "<p>Select your size, quantity, and click \"Add to Cart\".</p>" },
        { icon: "ClipboardList", title: "Checkout", body: "<p>Go to checkout and fill in your shipping information.</p>" },
        { icon: "CreditCard", title: "Make Payment", body: "<p>Choose your preferred payment method and complete your secure payment.</p>" },
        { icon: "PackageOpen", title: "Order Processing", body: "<p>We confirm your order and carefully pack your items.</p>" },
        { icon: "Truck", title: "Shipping", body: "<p>Your order is shipped and you will receive a tracking number.</p>" },
        { icon: "CheckCircle2", title: "Delivery", body: "<p>We deliver your order to your doorstep. Enjoy your purchase!</p>" },
      ], { variant: "steps" }),
      note("Safe, Secure & Trusted", "<p>Your security is our priority. We ensure every order is authentic, carefully packed, and delivered with care.</p>"),
      cta("Start Shopping", "/shop", { items: [{ title: "Read FAQs", href: "/customer-care/faqs" }] }),
    ],
  },
  {
    slug: "customer-care/shipping-policy",
    title: "Shipping Policy",
    template: "legal",
    subtitle: "We are committed to getting your order to you quickly and securely.",
    seoTitle: "Shipping Policy",
    seoDescription: "ASL ORIGINALS shipping policy: delivery times, processing, fees, delays and order tracking.",
    showInFooter: true,
    tags: ["legal"],
    blocks: [
      hero("Shipping Policy", "We are committed to getting your order to you quickly and securely."),
      rich(undefined, "<p>Below you will find important information about our shipping options, delivery times, and fees.</p>"),
      // U1: times + fees come from Admin → Shipping zones (old page: ₦5,000 / ₦15,000 / ₦10,000)
      rich("1. Delivery Time", "<p>We strive to process and deliver your orders as quickly as possible.</p>{{shipping.deliveryTimesTable}}", { icon: "Truck" }),
      rich("2. Processing Time", "<p>{{shipping.processingTime}} You will receive a confirmation email once your order has been shipped.</p>", { icon: "Clock" }),
      rich("3. Shipping Fees", "<p>Shipping fees are flat rates based on your delivery location. Delivery within Nigeria is free on orders over {{shipping.freeShippingThreshold}}.</p>{{shipping.deliveryFeesTable}}", { icon: "Wallet" }),
      rich("4. Delivery Delays", "<p>While we do everything possible to meet the estimated delivery times, delays may occasionally occur due to unforeseen circumstances beyond our control (e.g. weather, courier delays, or public holidays).</p>", { icon: "AlertTriangle" }),
      rich("5. Tracking Your Order", "<p>Once your order is shipped, you will receive a tracking number via email or SMS to monitor your delivery in real time.</p><p><a href=\"/customer-care/track-order\">Track your order →</a></p>", { icon: "MapPin" }),
      note("Important Note", "<p>{{shipping.importantNote}}</p>"),
    ],
  },
  {
    slug: "customer-care/return-policy",
    title: "Return Policy",
    template: "legal",
    subtitle: "Not completely happy? We accept returns within {{returns.windowDays}} days of delivery.",
    seoTitle: "Return Policy",
    seoDescription: "Return items within {{returns.windowDays}} days. Read the ASL ORIGINALS return conditions and process.",
    showInFooter: true,
    tags: ["legal"],
    blocks: [
      hero("Return Policy", "Not completely happy? We accept returns within {{returns.windowDays}} days of delivery."),
      rich(undefined, "<p>Please read the conditions below before initiating a return.</p>"),
      rich("1. Return Window", "<p>Returns must be initiated within <strong>{{returns.windowDays}} days</strong> of receiving your order. Requests made after this window will not be accepted.</p><p>Damaged, defective or incorrect items must be reported within <strong>{{returns.damagedReportHours}} hours</strong> of delivery, with at least one clear photo.</p>", { icon: "Clock" }),
      rich("2. Items Eligible for Return", "<ul><li>Unworn, unwashed and unused items</li><li>Items in their original packaging with all tags attached</li><li>Items free of stains, odours and damage caused by the customer</li></ul>", { icon: "CheckCircle2" }),
      // old copy said fragrances / personal care only "once opened"; the backend refuses these categories for any reason
      rich("3. Non-Returnable Items", "<ul><li>Items in these categories: {{returns.nonReturnableCategories}}</li><li>Sale, clearance and limited-edition drops</li><li>Concierge-sourced and custom orders</li><li>Pierced accessories</li></ul>", { icon: "XCircle" }),
      rich("4. How to Return an Item", "<ol><li>Start a return from Account → Orders within {{returns.windowDays}} days of delivery, or contact our support team.</li><li>Share your order number, reason for return and clear photos of the item.</li><li>We'll review your request and send you return instructions.</li><li>Ship the item back using the approved courier.</li></ol><p><a href=\"/account/returns\">Start a return →</a></p>", { icon: "PackageCheck" }),
      rich("5. Return Shipping Costs", "<p>Return shipping is {{returns.returnShippingPayer}} unless the item is defective or an incorrect item was shipped.</p>", { icon: "RotateCcw" }),
      note("Please note", "<p>All returns are inspected on arrival. Items returned in an unacceptable condition will be shipped back to you at your expense.</p>"),
    ],
  },
  {
    slug: "customer-care/refund-policy",
    title: "Refund Policy",
    template: "legal",
    subtitle: "Fair, transparent refunds - processed promptly once your return is approved.",
    seoTitle: "Refund Policy",
    seoDescription: "How ASL ORIGINALS processes refunds - timelines, methods, deductions and exceptions.",
    showInFooter: true,
    tags: ["legal"],
    blocks: [
      hero("Refund Policy", "Fair, transparent refunds - processed promptly once your return is approved."),
      rich("1. Refund Timeline", "<p>Refunds are processed within <strong>{{returns.refundProcessingDays}}</strong> after your returned item has been received and inspected.</p>", { icon: "Timer" }),
      rich("2. Refund Method", "<ul><li>Card &amp; Paystack payments - refunded to the original payment method.</li><li>Bank transfers - refunded to the account details you provide.</li><li>Wallet balance - credited instantly to your ASL Wallet.</li></ul>", { icon: "CreditCard" }),
      rich("3. Partial Refunds", "<p>A partial refund may apply if the returned item is not in its original condition, is missing tags or shows signs of use. Refunds cover the item price minus its share of any order discount.</p>", { icon: "Wallet" }),
      // old copy: "Original shipping fees (unless the return is due to our error)" — the backend never refunds shipping on returns
      rich("4. Non-Refundable", "<ul><li>Original shipping fees</li><li>Sale, clearance and limited-edition items</li><li>Concierge-sourced or custom-made orders</li></ul>", { icon: "Ban" }),
      note("Delayed Refunds?", "<p>If you haven't received your refund after {{returns.refundProcessingDays}}, please contact your bank first, then reach out to our support team at {{profile.supportEmail}}.</p>"),
    ],
  },
  {
    slug: "customer-care/privacy-policy",
    title: "Privacy Policy",
    template: "legal",
    subtitle: "Your privacy is important to us. This Privacy Policy explains how ASL ORIGINALS collects, uses, protects, and shares your information.",
    seoTitle: "Privacy Policy",
    seoDescription: "How ASL ORIGINALS collects, uses, protects, and shares your information.",
    showInFooter: true,
    tags: ["legal"],
    blocks: [
      hero("Privacy Policy", "Your privacy is important to us. This Privacy Policy explains how ASL ORIGINALS collects, uses, protects, and shares your information."),
      sectionList([
        ["User", "1. Information We Collect", "We collect information you provide directly to us, such as your name, email address, phone number, shipping address, billing information, and order details. We also collect certain information automatically, including device information, browser type, IP address, and browsing activity on our website."],
        ["Lock", "2. How We Use Your Information", "We use your information to process orders, provide customer support, personalize your shopping experience, improve our website and services, send important updates, and communicate promotional offers you may be interested in."],
        ["Share2", "3. Information Sharing and Disclosure", "We do not sell or rent your personal information. We may share your information with trusted third parties who help us operate our website, process payments, deliver orders, and provide customer support. These partners are obligated to keep your information secure."],
        ["ShieldCheck", "4. Data Security", "We implement appropriate security measures to protect your personal information against unauthorized access, alteration, disclosure, or destruction. While we strive to protect your data, no online system is completely secure."],
        // U8: self-service deletion, data removed after account.deletionGraceDays
        ["UserCheck", "5. Your Rights and Choices", "You have the right to access, update, or delete your personal information. You can delete your account yourself from Account → Settings; your personal data is removed {{account.deletionGraceDays}} days later. You can also opt out of promotional communications at any time. To exercise your rights, please contact us using the information provided below."],
        ["Cookie", "6. Cookies and Tracking Technologies", "We use cookies and similar technologies to enhance your browsing experience, analyze website traffic, and personalize content. You can manage your cookie preferences in your browser settings. For more details, please see our Cookie Policy."],
        ["Link2", "7. Third-Party Links", "Our website may contain links to third-party websites. We are not responsible for the privacy practices or content of these external sites. We encourage you to review their privacy policies."],
        ["Baby", "8. Children's Privacy", "Our website is not intended for children under the age of 13. We do not knowingly collect personal information from children. If we become aware that we have collected such information, we will delete it promptly."],
        ["Pencil", "9. Changes to This Privacy Policy", "We may update this Privacy Policy from time to time. Any changes will be posted on this page with the updated effective date. We encourage you to review this policy regularly."],
        ["Phone", "10. Contact Us", "If you have any questions about this Privacy Policy or our data practices, please contact us."],
      ]),
      contactCards,
      note("Your Privacy Matters", "<p>We are committed to protecting your personal information and ensuring transparency in everything we do.</p>"),
    ],
  },
  {
    slug: "customer-care/cookie-policy",
    title: "Cookie Policy",
    template: "legal",
    subtitle: "This Cookie Policy explains how ASL ORIGINALS uses cookies and similar technologies when you visit our website.",
    seoTitle: "Cookie Policy",
    seoDescription: "How ASL ORIGINALS uses cookies and similar technologies.",
    showInFooter: true,
    tags: ["legal"],
    blocks: [
      hero("Cookie Policy", "This Cookie Policy explains how ASL ORIGINALS uses cookies and similar technologies when you visit our website."),
      rich("1. What Are Cookies?", "<p>Cookies are small text files that are placed on your device when you visit a website. They help websites function properly, improve your experience, and provide information to the site owners.</p>", { icon: "HelpCircle" }),
      cols([
        { icon: "ListChecks", title: "Essential Cookies", body: "<p>These cookies are necessary for the website to function properly and cannot be disabled.</p>" },
        { icon: "BarChart3", title: "Performance Cookies", body: "<p>These cookies help us understand how visitors use our website so we can improve its performance.</p>" },
        { icon: "Settings2", title: "Functional Cookies", body: "<p>These cookies enable the website to remember your preferences and provide enhanced features.</p>" },
        { icon: "Megaphone", title: "Advertising Cookies", body: "<p>These cookies are used to deliver relevant ads and measure the effectiveness of our marketing campaigns.</p>" },
      ], { title: "2. How We Use Cookies", body: "<p>ASL ORIGINALS uses cookies for the following purposes:</p>", icon: "Cookie", variant: "list" }),
      sectionList([
        ["ListChecks", "3. Your Choices", "You can choose to accept, reject, or manage cookies at any time. You can update your cookie preferences through our Cookie Settings panel on the website. Please note that disabling certain cookies may affect the functionality of the website."],
        ["Building2", "4. Third-Party Cookies", "We may allow trusted third-party services to place cookies on your device to help us analyse website traffic, serve ads, and improve your overall experience. These third parties have their own privacy policies, and we encourage you to review them."],
        ["Pencil", "5. Updates to This Policy", "We may update this Cookie Policy from time to time to reflect changes in technology, legal requirements, or our business operations. Any updates will be posted on this page with the revised effective date."],
        ["Phone", "6. Contact Us", "If you have any questions about this Cookie Policy, please contact us."],
      ]),
      contactCards,
      rich("Cookie Consent", "<p>By continuing to browse or by clicking \"Accept All Cookies\", you agree to the use of cookies on our website as described in this policy.</p>", { variant: "cookie-consent", icon: "Cookie" }),
    ],
  },
  {
    slug: "customer-care/terms-of-service",
    title: "Terms of Service",
    template: "legal",
    subtitle: "Welcome to ASL ORIGINALS. By accessing or using our website, you agree to comply with and be bound by the following terms.",
    seoTitle: "Terms of Service",
    seoDescription: "The terms that govern your use of the ASL ORIGINALS website and services.",
    showInFooter: true,
    tags: ["legal"],
    blocks: [
      hero("Terms of Service", "Welcome to ASL ORIGINALS. By accessing or using our website, you agree to comply with and be bound by the following terms."),
      sectionList([
        ["FileText", "1. Acceptance of Terms", "By accessing or using the ASL ORIGINALS website, you agree to be bound by these Terms of Service and our Privacy Policy. If you do not agree with any part of these terms, please do not use our website."],
        ["Monitor", "2. Use of Our Website", "You agree to use our website for lawful purposes only. You must not use our website in any way that may damage, disable, or impair the site or interfere with any other user's experience."],
        ["Tag", "3. Products and Pricing", "We strive to display our products, pricing, and other information as accurately as possible. However, we do not warrant that product descriptions, prices, or other content is always accurate, complete, reliable, current, or error-free."],
        ["CreditCard", "4. Orders and Payment", "All orders are subject to availability and confirmation of payment. We reserve the right to refuse or cancel any order at our sole discretion, including in cases of pricing errors or suspected fraud."],
        ["Truck", "5. Shipping and Delivery", "We will deliver your order within the estimated timeframes provided. Delays may occur due to unforeseen circumstances. Please refer to our Shipping Policy for more details."],
        ["RotateCcw", "6. Returns and Refunds", "Returns and refunds are handled in accordance with our Return and Refund Policy. Please review the policy on our website for eligibility, conditions, and timeframes."],
        ["Copyright", "7. Intellectual Property", "All content on this website, including logos, images, text, graphics, and designs, are the property of ASL ORIGINALS and are protected by copyright and trademark laws."],
        ["AlertTriangle", "8. Limitation of Liability", "ASL ORIGINALS shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of our website or products."],
        ["Pencil", "9. Changes to Terms", "We reserve the right to update or change these Terms of Service at any time. Changes will be posted on this page with the updated effective date."],
        ["Phone", "10. Contact Us", "If you have any questions about these Terms of Service, please contact us."],
      ]),
      contactCards,
      note("Secure Shopping", "<p>Your security is important to us. We use industry-standard encryption to protect your information.</p>"),
    ],
  },
  {
    slug: "how-it-works",
    title: "How It Works - Concierge",
    template: "landing",
    subtitle: "Our fashion concierge service is designed for customers looking for exclusive, limited, sold-out or upcoming fashion pieces.",
    seoTitle: "How It Works - ASL ORIGINALS Concierge",
    seoDescription: "Simple. Personal. Premium. Learn how the ASL ORIGINALS fashion concierge sources exclusive, limited and sold-out pieces for you in six steps.",
    showInHeader: true,
    tags: ["concierge"],
    blocks: [
      hero("SIMPLE. PERSONAL. PREMIUM.", "Our fashion concierge service is designed for customers looking for exclusive, limited, sold-out or upcoming fashion pieces. Here's how we make it happen for you.", { eyebrow: "HOW IT WORKS" }),
      cols([
        { value: "1", icon: "FileText", title: "SUBMIT YOUR REQUEST", body: "<p>Fill out the request form with as much detail as possible. Include product name, brand, size, color, link or photo, and your budget.</p>" },
        { value: "2", icon: "Search", title: "WE REVIEW YOUR REQUEST", body: "<p>Our concierge specialists review your request carefully. If we need more information, we'll contact you.</p>" },
        { value: "3", icon: "ShoppingBag", title: "WE SOURCE YOUR ITEM", body: "<p>We search our trusted global network of verified suppliers to find your desired item.</p>" },
        { value: "4", icon: "Tag", title: "PRICE CONFIRMATION", body: "<p>Once we locate your item, we send you the final price, estimated delivery time and payment details.</p>" },
        { value: "5", icon: "ShieldCheck", title: "SECURE YOUR ORDER", body: "<p>After your payment confirmation, we secure your order and keep you updated at every step.</p>" },
        { value: "6", icon: "Truck", title: "DELIVERY TO YOU", body: "<p>Your item is carefully inspected, packed and delivered to your doorstep.</p>" },
      ], { variant: "steps" }),
      cols([
        { icon: "BadgeCheck", title: "AUTHENTIC GUARANTEED", body: "<p>Every item is 100% authentic and sourced from trusted official suppliers.</p>" },
        { icon: "Lock", title: "SECURE PAYMENT", body: "<p>Your payment is safe with us. Multiple secure payment options available.</p>" },
        { icon: "Headphones", title: "DEDICATED SUPPORT", body: "<p>Our team is here to assist you throughout the entire process.</p>" },
        { icon: "Package", title: "SAFE DELIVERY", body: "<p>Fast and secure delivery to your doorstep with tracking updates.</p>" },
        { icon: "RotateCcw", title: "EASY RETURNS", body: "<p>Return within {{returns.windowDays}} days of delivery if the item is unused and in original condition.</p>" },
      ], { variant: "trust" }),
      cols([
        { title: "SNEAKERS & STREETWEAR" }, { title: "LUXURY FASHION" }, { title: "WATCHES & ACCESSORIES" }, { title: "BAGS & LUGGAGE" },
        { title: "FRAGRANCES & BEAUTY" }, { title: "LIMITED EDITION DROPS" }, { title: "CUSTOM REQUESTS" },
      ], { title: "WHAT YOU CAN REQUEST", variant: "categories" }),
      cta("START YOUR REQUEST NOW", "/start-request"),
    ],
  },
  {
    slug: "concierge-service",
    title: "Concierge Service",
    template: "landing",
    subtitle: "Our fashion concierge service is designed for customers looking for exclusive, limited, sold-out, or upcoming fashion pieces that may not currently be available in our store.",
    seoTitle: "Concierge Service",
    seoDescription: "Browse all concierge categories - sneakers, luxury fashion, watches, bags, eyewear and more sourced by ASL ORIGINALS.",
    tags: ["concierge"],
    blocks: [
      hero("OUR FASHION CONCIERGE SERVICE IS DESIGNED FOR YOU.", "Our fashion concierge service is designed for customers looking for exclusive, limited, sold-out, or upcoming fashion pieces that may not currently be available in our store.", {
        ctaLabel: "START A REQUEST", ctaHref: "/start-request", alt: "Luxury concierge items",
      }),
      cols([
        { icon: "ShieldCheck", title: "TRUSTED SOURCING", body: "<p>We work with verified suppliers worldwide.</p>" },
        { icon: "BadgeCheck", title: "AUTHENTIC GUARANTEED", body: "<p>Every item is 100% authentic or your money back.</p>" },
        { icon: "Truck", title: "SAFE DELIVERY", body: "<p>Fast and secure delivery to your doorstep.</p>" },
        { icon: "Headphones", title: "DEDICATED SUPPORT", body: "<p>Our team is here to assist you every step of the way.</p>" },
      ], { variant: "trust" }),
      cols([
        { value: "1", icon: "FileText", title: "SUBMIT REQUEST", body: "<p>Fill out the request form with details of the item you want.</p>" },
        { value: "2", icon: "Search", title: "WE SOURCE", body: "<p>Our team searches trusted suppliers to find your item.</p>" },
        { value: "3", icon: "Tag", title: "PRICE CONFIRMATION", body: "<p>We send you the price and estimated delivery time.</p>" },
        { value: "4", icon: "CreditCard", title: "SECURE PAYMENT", body: "<p>Make payment to confirm and secure your order.</p>" },
        { value: "5", icon: "Package", title: "ORDER & PROCESS", body: "<p>We order, verify, and prepare your item for shipment.</p>" },
        { value: "6", icon: "Truck", title: "DELIVERY", body: "<p>Your item is delivered safely to your doorstep.</p>" },
      ], { title: "HOW IT WORKS", variant: "steps" }),
    ],
  },
];

/* ── FAQs (asl-web faqData.ts + account help topics; categories match ?category= on /account/help/:topic) ── */

const FAQ_CATEGORIES = [
  { slug: "orders", name: "Orders & Concierge", icon: "ShoppingBag", description: "Placing orders and concierge requests." },
  { slug: "payment", name: "Payment", icon: "CreditCard", description: "Payment methods, quotes and security." },
  { slug: "shipping", name: "Shipping & Delivery", icon: "Truck", description: "Delivery times, fees and tracking." },
  { slug: "returns", name: "Returns & Refunds", icon: "RotateCcw", description: "Return policy and refund process." },
  { slug: "other", name: "Other", icon: "MoreHorizontal", description: "Authenticity, sizing, loyalty and your account." },
];

type FaqSeed = [category: string, question: string, answer: string, opts?: { featured?: boolean; status?: "published" | "draft"; tags?: string[] }];
const EMAIL = "{{profile.supportEmail}}";

const FAQS: FaqSeed[] = [
  ["orders", "How do I place an order?", "Browse our collections, select your size and colour, and tap Add to Cart. Review your cart, then check out with your delivery details and preferred payment method. You will receive an order confirmation by email once your order is placed.", { featured: true }],
  ["orders", "What is Fashion Concierge?", "Fashion Concierge is our premium sourcing service - we find, authenticate and deliver luxury items from anywhere in the world, including pieces that are sold out or not in our catalogue."],
  ["orders", "What kinds of items can I request?", "You can request footwear, apparel, accessories, fragrances, watches, jewellery and other luxury lifestyle items."],
  ["orders", "How do I submit a concierge request?", "Tap Start a Request, share the product link or a photo, add your size and preferences, and our concierge team will reach out with a quotation."],
  // old: "within 2 - 6 hours … (Monday to Friday, 9 AM - 7 PM)" → concierge SLA + store hours from settings
  ["orders", "How long does it take to get a response?", "Our concierge team responds within {{concierge.responseSlaHours.standard}} hours - within {{concierge.responseSlaHours.priority}} hours for Gold members and {{concierge.responseSlaHours.vip}} hours for Signature members. Our hours: {{profile.serviceHoursText}}."],
  ["orders", "Can I request multiple items at once?", "Absolutely - you can submit multiple items in a single request and we will price and ship them together."],
  // old: "within 24 hours of placing your order" (account help: "within 1 hour") → the backend lets customers cancel until the order ships
  ["orders", "Can I change or cancel my order?", `You can cancel an order yourself from Account → Orders while it is awaiting payment or still being processed - once it has shipped, start a return instead. To change an order, contact us as soon as possible at ${EMAIL} and we will do our best to accommodate you. Concierge requests can be cancelled any time before payment.`],
  ["orders", "What if the item cannot be found?", "If we are unable to source your item, you will not be charged. We may suggest similar alternatives you might love."],
  ["orders", "Will an item be restocked?", "Yes, in most cases. Use the Notify Me option on the product page, enter your email address, and we will alert you the moment the item is available again."],
  ["orders", "How do I track my order or request?", `Every order comes with a tracking number. Go to Account → Orders and tap Track on the order to see live delivery updates. Concierge requests can be followed under Account → Requests, or on Track Request with your request number and email. Questions? Write to ${EMAIL}.`],

  // old: "Visa, Mastercard, American Express, bank transfers and mobile money … Apple Pay and Google Pay" → enabled payment methods
  ["payment", "What payment methods do you accept?", "We accept {{payments.methods}}. All payments are processed securely in Naira (₦).", { featured: true }],
  ["payment", "Will I know the price before paying?", "Yes. For concierge requests, we send you a full quotation including item cost, shipping and duties before any payment is made. For in-stock items, the full price is always shown at checkout."],
  ["payment", "How do concierge payments work?", "After you approve the quotation, we send a secure payment link. Once payment clears, we begin sourcing your item."],
  // there is no gift-card feature in the backend yet → kept as a draft until one exists
  ["payment", "Do you offer gift cards?", "Yes. ASL ORIGINALS gift cards are available in various denominations and can be used towards any product in our store. Gift cards are valid for 1 year from the date of purchase.", { status: "draft" }],

  // old: "processed within 1 - 3 business days … delivered within 7 - 14 business days" (account help: "Lagos 1 - 2, nationwide 3 - 5, international 7 - 14") → shipping zones
  ["shipping", "How long does delivery take?", "{{shipping.processingTime}} Estimated delivery times: {{shipping.deliveryTimesText}}. Concierge-sourced items arrive in the time confirmed in your quotation.", { featured: true }],
  ["shipping", "How much is delivery?", "Delivery fees are flat rates by location: {{shipping.deliveryFeesText}}. Delivery within Nigeria is free on orders over {{shipping.freeShippingThreshold}}."],
  ["shipping", "Do you ship internationally?", "Yes, we ship to select countries worldwide. Delivery times and fees vary by destination and are shown at checkout. Please note that customs duties, taxes and import fees are the responsibility of the customer."],
  ["shipping", "Which shipping companies do you use?", "Within Nigeria, we work with trusted local shipping partners and our own in-house logistics team. For international shipments, we rely on DHL for reliable, timely delivery."],
  ["shipping", "How do I track my order?", `Once your order ships, you will receive an email with a tracking number to use on the carrier's website. You can also track your order inside the app under Track Your Order. If you have not received a tracking number, contact us at ${EMAIL}.`],
  ["shipping", "How will my order be packaged?", "We ship items in their original branded packaging whenever possible. All orders are securely packed in protective boxes or bags, and some orders may arrive in our ASL ORIGINALS branded packaging. Display items may not include original packaging, but are packed with extra care."],
  ["shipping", "Can I change my shipping address after ordering?", `If your shipping address is incorrect, contact us immediately at ${EMAIL}. We will do our best to update it before your order ships, but once an order is processed or dispatched, changes may no longer be possible.`],
  ["shipping", "My order is delayed. What is happening?", `Delays can occur when billing and shipping addresses differ (extra security verification), when an item is temporarily backordered, or when international shipping details are incomplete. We sincerely apologise for any inconvenience - reach out to ${EMAIL} for an update and we will resolve it as quickly as possible.`],

  // old: "within 14 days of delivery" (account help also 14; account returns page "3 - 7 days") → returns.windowDays
  ["returns", "What is your return and refund policy?", "Items may be returned within {{returns.windowDays}} days of delivery in their original condition, unworn and with all tags attached. Refunds are issued to the original payment method within {{returns.refundProcessingDays}} after the returned item is inspected. Sourced concierge items are final sale unless they arrive damaged, incorrect or inauthentic. See our Return Policy and Refund Policy for full details.", { featured: true }],
  ["returns", "How do I start a return?", "Go to Account → Orders, open the order and choose Return item within {{returns.windowDays}} days of delivery. We'll review your request and send you return instructions."],
  ["returns", "My order arrived damaged or incorrect. What do I do?", "We sincerely apologise. Contact us within {{returns.damagedReportHours}} hours of delivery with photos and a description of the issue, and we will gladly arrange a replacement or refund."],
  ["returns", "When will I get my refund?", "Refunds are processed within {{returns.refundProcessingDays}} after we receive and inspect your return. Refunds to your ASL Wallet are instant."],
  ["returns", "My refund is delayed. What should I do?", `Refunds are processed after we receive and inspect your returned item. If your refund seems delayed, contact our customer service team at ${EMAIL} and we will look into it immediately.`],

  ["other", "Are your products authentic?", "Yes. Every product sold at ASL ORIGINALS is 100% authentic and sourced from trusted suppliers. We guarantee the quality and authenticity of every item you purchase from us.", { featured: true }],
  ["other", "How do I find my size, and how do I care for my items?", `We provide detailed size guides for each product, tailored to the brand and fit, so you can shop with confidence. Care instructions and material composition are provided whenever possible. Still unsure? Contact us at ${EMAIL} and we will be happy to assist.`],
  ["other", "Do you offer discounts, sales or a loyalty program?", "We run special promotions and seasonal sales throughout the year, announced through our newsletter and social channels. Our ASL Club loyalty program lets you earn points on purchases that can be redeemed for future discounts - our way of thanking you for your continued support."],
  ["other", "Do you offer wholesale or bulk purchasing?", `Yes, we offer wholesale and bulk purchasing for businesses and resellers. For large or custom orders, reach out to our sales team at ${EMAIL} for more information.`],
  ["other", "I forgot my account password. What do I do?", "Tap Forgot Password on the sign-in page, enter your email address, and we will send you a link to reset your password."],
  // old: "Monday to Friday, 9 AM - 7 PM" → profile.serviceHours
  ["other", "How do I contact customer service?", `You can reach us at ${EMAIL} or on WhatsApp at {{profile.whatsapp}}. Our customer service team is available {{profile.serviceHoursText}} and is always happy to help.`],
];

/* ── SEO defaults per path (admin seo mock, without the fake Search Console numbers) ── */

const SEO_PAGES: { path: string; type: string; title: string; description: string; keywords?: string[]; schemaType?: string }[] = [
  { path: "/", type: "home", title: "ASL ORIGINALS - Luxury footwear, fashion & fragrance", description: "Shop authenticated luxury from the world's most coveted houses. Concierge sourcing, white-glove delivery across Nigeria.", keywords: ["luxury fashion nigeria", "designer footwear", "asl originals"], schemaType: "WebSite" },
  { path: "/shop", type: "shop", title: "Shop - Designer footwear, apparel & accessories", description: "Browse curated luxury from Fear of God, Amiri, Rick Owens, Chrome Hearts and more.", keywords: ["luxury shop", "designer brands"], schemaType: "CollectionPage" },
  { path: "/best-sellers", type: "collection", title: "Best sellers - Most-wanted luxury pieces", description: "Trending and best-selling luxury pieces this week at ASL ORIGINALS.", keywords: ["best sellers luxury"] },
  { path: "/shop/sales", type: "collection", title: "Sales - Limited-time luxury markdowns", description: "Limited-time markdowns on authenticated luxury.", keywords: ["luxury sale", "designer discount"] },
  { path: "/start-request", type: "concierge", title: "Start your concierge request", description: "Request any luxury piece from any brand, sourced by our concierge team." },
  { path: "/faq", type: "policy", title: "FAQ - ASL ORIGINALS Concierge", description: "Answers to common questions about the ASL ORIGINALS Fashion Concierge - requests, payment, shipping, returns and support.", schemaType: "FAQPage" },
  { path: "/customer-care/faqs", type: "policy", title: "FAQs", description: "Answers to the most common questions about shopping with ASL ORIGINALS.", schemaType: "FAQPage" },
];

const BLOG_CATEGORIES = [
  { slug: "style", name: "Style", colour: "#8a6a1c" },
  { slug: "editorial", name: "Editorial", colour: "#3b2e12" },
  { slug: "guides", name: "Concierge Guides", colour: "#0f3460" },
  { slug: "house-notes", name: "House Notes", colour: "#5b3a3a" },
];

export async function seedContent(prisma: PrismaClient, log: (msg: string) => void = console.log) {
  let created = 0;
  for (const [n, p] of PAGES.entries()) {
    if (await prisma.page.findUnique({ where: { slug: p.slug }, select: { id: true } })) continue;
    const key = p.slug.replace(/[^a-z0-9]+/g, "-");
    await prisma.page.create({
      data: {
        slug: p.slug, title: p.title, template: p.template, status: "published", visibility: "public", subtitle: p.subtitle ?? null,
        author: "ASL ORIGINALS", seoTitle: p.seoTitle, seoDescription: p.seoDescription, showInHeader: p.showInHeader ?? false,
        showInFooter: p.showInFooter ?? false, tags: p.tags,
        blocks: p.blocks.map((b, i) => ({ ...b, id: (b.id as string | undefined) ?? `${key}-${i}`.slice(-40) })),
        // keeps the seed order for navigation (sorted by createdAt)
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)),
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
      },
    });
    created++;
  }

  for (const [i, c] of FAQ_CATEGORIES.entries())
    await prisma.faqCategory.upsert({ where: { slug: c.slug }, create: { ...c, position: i }, update: {} });
  const cats = new Map((await prisma.faqCategory.findMany()).map((c) => [c.slug, c.id]));
  let faqs = 0;
  const positions = new Map<string, number>();
  for (const [slug, question, answer, opts] of FAQS) {
    const categoryId = cats.get(slug)!;
    const position = positions.get(slug) ?? 0;
    positions.set(slug, position + 1);
    if (await prisma.faqItem.findFirst({ where: { categoryId, question }, select: { id: true } })) continue;
    await prisma.faqItem.create({
      data: {
        categoryId, question, answer: `<p>${answer}</p>`, position, author: "ASL ORIGINALS", status: opts?.status ?? "published",
        featured: opts?.featured ?? false, tags: opts?.tags ?? [],
      },
    });
    faqs++;
  }

  for (const s of SEO_PAGES)
    await prisma.seoPage.upsert({ where: { path: s.path }, create: { ...s, keywords: s.keywords ?? [], schemaType: s.schemaType ?? null }, update: {} });

  for (const c of BLOG_CATEGORIES) await prisma.blogCategory.upsert({ where: { slug: c.slug }, create: c, update: {} });
  if (!(await prisma.blogAuthor.count())) await prisma.blogAuthor.create({ data: { name: "ASL ORIGINALS Editorial", role: "Editorial team" } });

  log(`content ✓  ${created} new page(s), ${faqs} new FAQ(s), ${SEO_PAGES.length} SEO paths, ${BLOG_CATEGORIES.length} blog categories`);
}
