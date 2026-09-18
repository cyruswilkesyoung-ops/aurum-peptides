# Aurum: owner setup and day-to-day orders

This file lives under `netlify/`, which the site never serves. It replaces the
"Environment variables" and "Confirming an order" sections of the old public
/guide/ page, removed 2026-09-18.

## Environment variables (Netlify: Site configuration > Environment variables)

The store refuses to take an order until at least one payment method is set.
Any method left unset is simply not shown on the payment screen. After changing
a variable, trigger a redeploy; Netlify does not apply it to running functions.

Payment, at least one of:

    CRYPTO_BTC_ADDRESS    CRYPTO_BTC_NETWORK
    CRYPTO_ETH_ADDRESS    CRYPTO_ETH_NETWORK
    CRYPTO_USDT_ADDRESS   CRYPTO_USDT_NETWORK
    CRYPTO_USDC_ADDRESS   CRYPTO_USDC_NETWORK
    CASHAPP_CASHTAG       CASHAPP_NAME        (cashtag with or without the $)
    ZELLE_CONTACT         ZELLE_NAME          (the email or phone that receives Zelle)

The network is printed next to the address on the buyer's screen and must be the
chain that wallet actually lives on. Coins sent over the wrong chain are gone and
nobody can reverse it. This is the one setting where a mistake cannot be undone.

Older spellings still accepted: CRYPTO_BTC, CRYPTO_ETH, CRYPTO_USDT_TRC20,
CRYPTO_USDC_ERC20, CASHAPP_HANDLE.

Admin:

    ADMIN_PASSWORD        gates /admin/. Unset means nobody can get in.

Order emails (optional, recommended; provider is Resend, free tier 3,000/month):

    RESEND_API_KEY  EMAIL_FROM  ADMIN_EMAIL

Without these, orders still save and show in /admin/, only the emails are skipped.

Wording on the payment screen:

    ORDER_CONFIRM_WINDOW  the "typically confirmed within ..." text
    SUPPORT_EMAIL         the contact address shown to the buyer

## Day to day

1. Email arrives: new order AUR-XXXXXX for $X, with items and shipping address.
2. Funds land. Match the payment memo to that reference.
3. Open /admin/, sign in, press Mark paid. It asks whether to email the buyer.
4. When it ships, paste the tracking number and press Save & ship. The buyer
   gets the tracking email.
5. If a payment never arrives, Cancel records it and notifies nobody.
