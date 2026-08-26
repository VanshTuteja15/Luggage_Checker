# Luggage Watch

Build a full-stack web application called **LuggageTracker** — a luggage price monitoring dashboard for a single admin user.




Tech stack: **React + TypeScript + Tailwind CSS + shadcn/ui + Recharts + Supabase (PostgreSQL)**. Use clean, modern, minimal design. Dark sidebar navigation. Light main content area. No clutter.




## Brand & Design System




- App name: **LuggageTracker**

- Logo: A suitcase icon next to the text "LuggageTracker" in the sidebar and login page

- Primary color: Indigo (#4F46E5)

- Accent/success: Emerald green (#10B981)

- Danger/price up: Red (#EF4444)

- Warning: Amber (#F59E0B)

- Background: #F9FAFB (light gray)

- Cards: White with subtle border (#E5E7EB) and light shadow

- Sidebar: Dark (#111827) with white/gray text

- Font: Inter or system sans-serif

- Border radius: 8px on cards, 6px on buttons and inputs

- The overall feel should be like a premium SaaS analytics dashboard — think Linear, Vercel, or Stripe Dashboard




## Authentication




Simple admin login page. No signup — just a single admin account.




- Login page with email + password fields

- "LuggageTracker" logo centered above the form

- "Sign in to your account" subheading

- Remember me checkbox

- Sign in button (indigo)

- Clean, centered card on a light gray background

- After login, redirect to Dashboard




## Sidebar Navigation (persistent, left side, dark)




The sidebar should be visible on all pages after login. It contains:




- **LuggageTracker** logo and name at the top

- Navigation items with icons:

  - Dashboard (grid/home icon) — default active page

  - Search Products (search icon)

  - Tracked Products (bookmark/list icon)

  - Price History (chart/trending icon)

  - Settings (gear icon)

- At the bottom of the sidebar:

  - Admin user avatar/name

  - Logout button

- Active nav item has an indigo highlight/background

- Sidebar should be collapsible on smaller screens (hamburger menu)




## Page 1: Dashboard (main page after login)




This is the command center. The admin sees everything at a glance.




### Top Stats Row (4 stat cards in a horizontal row)




1. **Tracked Products** — shows total count (e.g., "32"), with a small package/suitcase icon, light indigo background

2. **Price Drops Today** — shows count (e.g., "5"), with a trending-down arrow icon, light green background

3. **Price Increases Today** — shows count (e.g., "2"), with a trending-up arrow icon, light red background

4. **Last Price Check** — shows timestamp (e.g., "Today, 9:04 AM MT"), with a clock icon, light gray background




### Section: Today's Price Drops (show only if there are drops)




A card/section titled "Today's Price Drops" with a green accent.




Show a list/table of products whose price dropped today:




| Product | Previous Price | Current Price | Drop | Retailer | 

|---------|---------------|---------------|------|----------|

| Samsonite Freeform 28" | $179.99 | $169.99 | -$10.00 | Walmart |




- Each row shows product name, product image thumbnail, old price (strikethrough), new price (green bold), dollar amount dropped (green badge), and the retailer where the lowest price was found

- Clicking a row opens the Product Detail page




### Section: Today's Price Increases (show only if there are increases)




Same layout as above but with red accent. Show products whose price went up.




| Product | Previous Price | Current Price | Increase | Retailer |

|---------|---------------|---------------|----------|----------|

| TUMI Alpha 3 | $750.00 | $795.00 | +$45.00 | Amazon |




### Section: All Tracked Products (main table)




A full data table showing ALL tracked products. Columns:




- Checkbox (for bulk actions)

- Product Image (small thumbnail, 40x40)

- Product Name (bold) with brand name below it in gray

- UPC (small gray text)

- Lowest Price (large, bold, with currency)

- Retailer (where the lowest price is from, with small retailer logo/icon if possible)

- Change (green down arrow with amount for drops, red up arrow for increases, gray dash for no change)

- Stock Status (green "In Stock" badge or red "Out of Stock" badge)

- Last Checked (relative time, e.g., "2 hours ago")

- Actions (three-dot menu with: View Details, Remove from Tracking)




The table should have:

- Search/filter bar at the top

- Filter by: Brand, Price Range, Stock Status, Price Change

- Sort by any column

- Pagination (20 per page)




### Quick Add Button




A floating or top-right "+ Add Product" button (indigo) that navigates to the Search Products page.




## Page 2: Search Products




This is where the admin finds and adds new products to track.




### Search Section




A large, prominent search bar at the top of the page with:

- Search input with placeholder: "Search by product name, UPC, brand, or model..."

- A dropdown/tabs to filter search type: All, Product Name, UPC, Brand, Color

- Search button (indigo)

- Below the search bar: "Search across Amazon, Walmart, Target, and more"




### Search Results




After searching, show results in a grid of product cards (3 or 4 columns).




Each **Product Card** contains:

- Product image (large, top of card)

- Product name (bold, 2 lines max, truncate)

- Brand name (gray, below product name)

- Price range found: "From $149.99 — $189.99"

- Number of retailers: "Found at 4 retailers"

- "Track This Product" button (indigo outline). If already tracked, show "Already Tracked" (green, disabled)

- Clicking the card opens a modal or detail panel (not a new page) showing:

  - Larger product image

  - Full product name

  - Brand, model, color, UPC

  - List of retailers with individual prices, stock status, and links

  - "Add to Tracking" button




### Empty State




If no results: Show a friendly illustration with "No products found. Try a different search term."




### Recent Searches




Below the search bar (before searching), show a "Recent Searches" section with the last 5 search queries as clickable chips/tags.




## Page 3: Tracked Products




A dedicated page for managing all tracked products.




### View Toggle




Top right: Grid view / List view toggle buttons.




### Grid View




Product cards in a responsive grid (3-4 columns). Each card:

- Product image

- Product name (bold)

- Brand (gray)

- Current lowest price (large, bold)

- Retailer name

- Price change badge (green/red/gray)

- Stock status badge

- Small sparkline chart showing 7-day price trend (tiny inline chart)

- Three-dot menu: View Details, Remove from Tracking




### List View




Table format similar to the Dashboard "All Tracked Products" table.




### Filters




Sidebar or top filter bar:

- Brand (multi-select checkboxes)

- Price range (slider or min/max inputs)

- Stock status (In Stock / Out of Stock / All)

- Price trend (Dropping / Rising / Stable / All)

- Sort by: Name, Price (Low-High), Price (High-Low), Biggest Drop, Recently Added




### Bulk Actions




When checkboxes are selected, show a floating action bar:

- "Remove Selected" (red)

- "Export Selected" (CSV export)

- Count of selected items




## Page 4: Product Detail Page




When clicking on any product from Dashboard, Tracked Products, or Search Results.




### Product Header




- Large product image on the left (with image gallery if multiple images)

- Right side:

  - Product name (large, bold)

  - Brand | Model | Color

  - UPC code (with copy button)

  - Current lowest price (very large, bold, indigo) with retailer name

  - Price change badge

  - "Remove from Tracking" button (red outline) or "Track This Product" button (indigo)




### Retailer Price Comparison Table




A table showing ALL retailers where this product was found:




| Retailer | Price | Stock Status | Last Checked | Link |

|----------|-------|-------------|--------------|------|

| Amazon | $179.99 | In Stock | 2h ago | Visit → |

| Walmart | $169.99 | In Stock | 2h ago | Visit → |

| Target | $184.99 | Out of Stock | 2h ago | Visit → |

| Samsonite.com | $189.99 | In Stock | 2h ago | Visit → |




- Highlight the row with the lowest price (light green background)

- "Visit" link opens the retailer product page in a new tab

- Show retailer logo/favicon next to retailer name




### Price History Chart




A large Recharts line chart showing price history over time.




- X-axis: Dates

- Y-axis: Price ($)

- One line per retailer (different colors, with legend)

- Time range selector: 7 days, 30 days, 90 days, All Time

- Hover tooltip showing exact price, date, and retailer

- Highlight the lowest price point on the chart




### Price Statistics Card




Below or beside the chart:

- Current Price: $169.99

- Lowest Ever: $149.99 (with date)

- Highest Ever: $199.99 (with date)

- Average Price: $174.50

- Price checked: 45 times




## Page 5: Price History (global)




A page showing price trends across ALL tracked products.




### Overview Chart




A large area chart or multi-line chart showing overall price trends of all tracked products (or top 10).




### Price History Table




| Product | Current | 7d Ago | 30d Ago | Lowest Ever | Trend |

|---------|---------|--------|---------|-------------|-------|

| Samsonite Freeform | $169.99 | $179.99 | $189.99 | $149.99 | ↓ Dropping |




- Trend column shows a small sparkline and a text label

- Filter by brand, date range

- Export to CSV button




## Page 6: Settings




### General Settings

- Admin email (for daily reports)

- Timezone display setting

- Dashboard refresh interval




### Daily Report Settings

- Enable/disable daily email report

- Email address to send reports to

- Report time (default: 9:00 AM MT — shown as info, not editable since it's GitHub Actions)

- What to include in report: checkboxes for Price Drops, Price Increases, Out of Stock alerts, Summary stats




### Data Sources Settings

- SerpAPI key input (password field with show/hide toggle)

- Test connection button

- Supported retailers checklist (Amazon, Walmart, Target, etc.)




### Danger Zone

- "Clear All Price History" button (red, with confirmation modal)

- "Remove All Tracked Products" button (red, with confirmation modal)




## Global Components




### Toast Notifications

- Success: "Product added to tracking" (green)

- Error: "Failed to fetch prices" (red)

- Info: "Price check in progress..." (blue)

- Use bottom-right toast position




### Loading States

- Skeleton loaders for cards and tables while data loads

- Spinner for search results

- Progress bar for bulk operations




### Empty States

- Dashboard with no tracked products: "Start by adding products to track. Your price monitoring dashboard will appear here." with a "Search Products" button

- Tracked Products empty: "No products tracked yet."

- Search no results: "No products found."

- Price History empty: "Price history will appear after the first daily check."




### Responsive Design

- Desktop: Full sidebar + content

- Tablet: Collapsible sidebar, 2-column grids

- Mobile: Hidden sidebar (hamburger), single column, stacked cards




### Confirmation Modals

- "Remove from Tracking" — "Are you sure? Price history will be preserved."

- "Clear All History" — "This action cannot be undone. Type DELETE to confirm."




## Sample Data




Pre-populate the app with realistic sample data so the design looks real:




**Products:**

1. Samsonite Freeform Hardside Expandable 28" — $169.99 (Walmart) — Price dropped $10

2. Travelpro Maxlite 5 Lightweight 25" — $149.99 (Amazon) — No change

3. American Tourister Stratum XLT 24" — $109.99 (Walmart) — Price dropped $15

4. TUMI Alpha 3 Extended Trip Packing Case — $795.00 (Amazon) — Price up $45

5. Away The Large Suitcase — $345.00 (Away.com) — No change

6. Briggs & Riley Baseline 27" Expandable — $679.00 (Amazon) — Price dropped $20

7. Delsey Paris Chatelet Air 2.0 28" — $249.99 (Target) — No change

8. Travelpro Platinum Elite 29" — $329.99 (Amazon) — Price up $10

9. Samsonite Omni 2 Hardside 24" — $139.99 (Walmart) — Price dropped $20

10. Victorinox Spectra 3.0 Large Case — $449.99 (Amazon) — No change




**Retailers:**

- Amazon (logo: orange arrow)

- Walmart (logo: blue spark)

- Target (logo: red bullseye)

- Samsonite.com

- Away.com

- TUMI.com

- Travelpro.com




**Price history:** Generate 30 days of realistic price fluctuation data for each product across each retailer. Prices should vary by $5-$30 over time with occasional bigger drops and increases.




## Important Design Rules




1. NO clutter. Every element must earn its space.

2. Generous whitespace between sections.

3. Tables should be clean with subtle row hover effects (light gray background on hover).

4. All prices should be formatted as USD with 2 decimal places.

5. Use proper number formatting (commas for thousands).

6. All timestamps should show relative time ("2 hours ago") with full date on hover tooltip.

7. Cards should have subtle hover lift effect (translate-y and shadow increase).

8. Use consistent icon set (Lucide icons).

9. No gradients anywhere. Flat colors only.

10. The design should feel fast and professional — like a tool built for someone who checks it every morning at 9 AM.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/165f8a60-3fe5-4181-9f80-1dbdc3d48f38).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
