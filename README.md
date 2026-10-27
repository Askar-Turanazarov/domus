# Domus — квартиры и мебель в 3D

**[English](#english) · [O‘zbekcha](#ozbekcha) · [Русский](#русский)**

---

## English

A web app for custom furniture: the client plans a whole apartment (or picks one in a new building), enters the room size and the furniture dimensions, checks what fits and where on a 2D plan, walks through the room in 3D and sends an order.

### Features
- **Room:** length, width, height (cm); the plan is rebuilt instantly.
- **Furniture (15 types):** wardrobe, bed, sofa, armchair, table, desk, coffee table, chair, nightstand, dresser, TV stand, bookshelf, shoe cabinet, kitchen set, fridge — width (X), depth (Y), height (Z).
- **2D plan (Canvas, top view):** auto scale, 10/50 cm grid, plinth inset (2 cm by default). The scale stays fixed: messages go to a separate column on the right.
- **Distances** from the selected item to the walls and to furniture in between: if a neighbour covers the whole side, only the distance to it is shown; if it covers part of the side, both (to the neighbour and to the wall).
- **Drag & drop** with snapping (5 cm) and magnet to walls/neighbours; rotation 0/90/180/270° (`R`) with a front-side marker.
- **Validation:** an item turns **red** if it crosses a wall (incl. plinth), overlaps another item (AABB), is closer than the minimum gap (3 cm), taller than the ceiling or blocks a door swing. Tall furniture in front of a window gets a yellow warning. The notes column shows the exact reasons for every item.
- **Windows & doors:** any number on any wall; drawn on the plan (glass, door leaf and swing arc), dragged along the wall or onto another one, edited in the sidebar (offset, width, height, sill, hinge side). The 🔒 lock keeps them from moving by accident while arranging furniture. Openings are synced to 3D and saved in the order.
- **"Find a spot":** searches free positions (walls first, back to the wall, 4 rotations). Found → green highlight; not found → a precise message, e.g. *"Does not fit: 15 cm short in width along the south wall"*.
- **3D scene (Three.js):** room with window, door and plinths, procedural furniture models, lamp and daylight with shadows.
  - **Overview** — orbit camera, near walls are cut away.
  - **Walk** — first person, collisions with walls and furniture; person height 120–200 cm; the bottom HUD shows the floor distance from the feet to the item or wall you are looking at.
  - **Simple / Photo** textures (procedural or CC0 photo textures). Photo is the default (Simple on obviously weak devices: software rendering, ≤ 2 cores or ≤ 2 GB, old phone GPUs; and at Quality “Low”); the choice is remembered. Library sets a finish needs are downloaded by the server at once.
- **Photo textures panel:** apply the built-in CC0 set in one click, download it (per surface or the whole set as ZIP), or upload your own photo for the floor, walls, furniture wood or upholstery (reset back to built-in anytime); your own photos stay in your browser (IndexedDB) — other visitors don't see them.
  - Fullscreen mode, touch joystick on mobile.
- **Plan editing:** undo / redo (↶ ↷, `Ctrl+Z` / `Ctrl+Y`; a whole drag is one step), duplicate (`Ctrl+D`), multi-select (`Shift`/`Ctrl`+click, `Shift`+drag box, `Ctrl+A`) with group move and an **Align / distribute** panel.
- **Zoom & pan:** wheel zooms around the cursor (50–800 %), − / 100 % / + buttons (100 % = fit); pan by dragging the empty floor, `Space`+drag or the middle button; pinch on touch screens. The view is not saved.
- **Ruler** (📏 / `M`): click two points; points snap to walls, plinth and furniture edges, `Shift` keeps the line straight. Shows the length and Δx / Δy; ⌫ clears all measurements.
- **Structure:** in the "Windows, doors & structure" panel add a column, duct (riser), ceiling duct, wall ledge, radiator (centred under a window) or a **niche** (two ledges on both sides of a wall part). They are hatched grey on the plan with the height label, dragged with snapping to walls, edited in the form and protected by the same 🔒 lock. Furniture must not overlap structure at its height (`err.obstacle`, plus the min gap); structure in a door swing or in front of a window gets a warning. In 3D structure is drawn in wall material, the radiator is sectional; it blocks the walk unless it is above the head.
- **Wall-mounted furniture:** every item has "Above floor" (`elev`, cm). Collisions work on three axes: a shelf above a desk is fine, a wardrobe under a ceiling duct is checked against its bottom, a shelf in a door swing is an error only below the door top. On the plan wall items are drawn over the floor ones (translucent, dashed, "↑140"); a click picks the upper item, a second click on the same spot picks the one below. New catalogue types: wall cabinet, wall shelf, mezzanine, floating TV console, wall mirror.
- **Opening zones:** wardrobes, dressers, kitchens, fridges and wall cabinets know how they open (hinged doors, sliding, drawers, pull-out; can be changed per item, with the number of doors). If a door or drawer hits a wall, furniture or structure at its height — an error with the shortfall: "Door/drawer will not open: “Bed” is in the way (20 cm short)". Two zones over the same floor or a zone in the room door swing give a warning. **⌓ Zones** (key `Z`) cycles: selected only → all → hidden; checks run in every mode, a selected item with a zone error always shows its zone. Auto-placement first looks for a spot with a free zone.
- **Passages:** gaps between furniture, structure and walls narrower than the norm (setting "Passage from", 60 cm by default; gaps under 20 cm are slits, not passages) are warned: "Narrow passage 48 cm (should be 60+)". **↔ Passages** (key `P`) shows / hides the yellow bands on the plan, the badge shows how many there are; the notes column has a collapsible "Passages (N)" group, a click flashes the passage on the plan.
- **Projects and rooms:** a project holds several rooms shown as tabs above the plan (+ Room: name, purpose, size; ⋯ — rename, duplicate as a version "variant B", delete). Each room keeps its own undo history. 📁 **Projects** — cards with a plan preview: open, new, rename, duplicate, delete, **export / import** a `.fsp3d.json` file (backup or moving to another device). The old single-room plan is migrated automatically into "My project".
- **Room templates:** + Room → **From a template**: a *Soviet-era building* set (panel / brick 1960–90s, ceiling ≈ 2.8 m) or a *New build* set (monolithic frame 2015+, ceiling ≈ 3.0 m) — bedroom, kids room, kitchen-living room, master bedroom, living room (the Soviet one is walk-through with two doors), large bedroom, study, kitchen. Each card shows a mini plan and "12 m² · 4×3 m". A template brings windows with radiators under them, doors, structure (risers, a ledge, a column) and furniture placed without errors; afterwards everything can be changed. 📁 Projects → **New project from an apartment template**: "2-room (Soviet)" = living room + bedroom + kitchen, "3-room (new build)" = kitchen-living room + master bedroom + kids room, one tab per room. Sizes are typical for Tashkent housing; templates live in `templates.json` (`GET /api/templates`).
- **3D look:** 📷 *Snapshot* saves a PNG (2× resolution) with a summary plate — project, room, purpose, size and area, item count, date; ⤴ *Share* on phones; 📷 next to the ruler saves the plan. Each item gets a **material** from the catalogue (oak, walnut, white ash, matte white, graphite, sage, gloss, fabrics, velour) — for wardrobes, dressers, kitchens etc. separately for the **body and the facade** — or its own colour. **Light:** ☀ day / 🌇 evening (low warm sun, lamps on) / 🌙 night (dark window, only lamps) and the ceiling light: chandelier, spots, LED panel or none — the same fixtures with realistic brightness in every room (spots are narrow cones, light does not pass through walls); **Soft shadows** (on by default) put a soft patch under every piece of furniture and shade the room corners — stable from any angle, on every device (replaces screen-space AO); the catalogue has a floor lamp and a wall sconce with their own light. **Finish** (Room → *Finish and style*): walls — paint, wallpaper, brick, panels + colour, an accent wall in its own colour, floor — parquet, laminate, tile, carpet; **furniture style** modern / classic (brass knobs, turned legs, moulded fronts) / loft (black steel) for the room or a single item — sizes and collisions do not change. Lighting and finish are saved with the room and can be undone.
- **Opening in 3D:** click a wardrobe, dresser, kitchen, fridge or a room door (or `E` while walking) — doors swing, drawers slide out, flaps fall open; 🚪 *Open all* / *Close all*. Every frame the moving part is checked against other furniture, structure and walls: on contact it turns red, stops and the HUD says "The door hits «Bed» at 64°".
- **Configurator and price estimate:** wardrobes, dressers, nightstands, shoe cabinets and kitchens get *Sections* and *Drawers* (sliding wardrobes — 2–3 doors); the 3D model follows (hollow carcass, partitions, shelves, a rail, drawers), the plan shows sections as dashed lines. The selected item shows "≈ 2 310 000 sum" (hover — breakdown: carcass, facade, doors, hardware…), the furniture list — "Estimated total from …"; the total also goes onto the snapshot plate and into the order. **Prices in `catalog.json` → `pricing` and `materials[].priceRate` are TEST values — replace them with real ones before going live.**
- **Fill a niche** (📐): hover near a wall — a green ghost of the largest wardrobe that fits there (keeps the plinth and gaps, leaves the passage in front, stops 5 cm below the ceiling or a ceiling duct); click — pick it, choose sliding or hinged doors with prices, *Apply* adds the configured wardrobe as one undo step.
- **Compare variants:** room tab ⋯ → *Compare with…* — two rooms of the project side by side (read only) with size, item count, errors and price; by default another version of the same room.
- **Order drawing:** the order carries a drawing — the plan at a standard scale 1:N on a white A4 sheet (2400 px) with numbered items, their sizes and distances to the walls, windows, doors, structure and a stamp (project, room, size, scale, price, order №, date) — plus a 3D picture if the 3D view is open. The server stores them in `orders/<id>/plan.png` (`3d.jpg`). **🖨 Drawing / PDF** in the order form opens `print.html`: the drawing and the specification (№, item, size, height above the floor, material and configuration, price) → *Print / PDF* → "Save as PDF", no libraries.
- **Order** — form (name, phone, comment) is saved to `order.json` with the project and room names; the "send all rooms" checkbox sends every room of the project (each one must be free of errors). The server checks every order (`server/validateOrder.js`: field whitelist, ranges — sizes 50–3000 cm, ≤ 200 items, ≤ 50 openings / structure, phone mask, PNG signature and ≤ 2 MB for the drawing), allows 5 orders per IP in 10 minutes ("Too many orders" otherwise), silently drops bots that fill the hidden `website` field and writes `order.json` through a queue (temp file + rename), so parallel orders are never lost.
- **Manager page** `/admin.html` (see below): orders table — №, date, name, phone (`tel:` link), project / room, total, status; filter by status and search; statuses **new → in progress → measuring → done** (+ cancelled) with a dated history; the order card shows the drawing, 3D picture, specification, client comment and manager notes.
- **Whole apartment:** a project is one apartment — its rooms stand on one plan, a door in a shared partition (10 cm) leads to the neighbour room. The header shows the area, the active room and **⎘ Variants** (copies of the whole apartment). **✥ Layout** — drag the rooms, they stick to neighbours one partition apart (`Esc` — exit). Furniture can be dragged from one room to another. Old one-room projects are migrated automatically.
- **Apartment templates:** 📁 Projects → *Apartment from a template* — *khrushchevka* (series 1-447, 1-464, II-29), *improved layout* (1-528, II-49, II-57, 121) and *new build* (studio, euro one-bedroom, 2–4 rooms), empty or furnished (`apartment-templates.json`, `GET /api/apartments`).
- **Kits:** 🎲 *Furnish* places a ready-made kit by the room purpose (bedroom, kids, living, kitchen, study, hall, bathroom…) — for one room or the whole apartment, a new variant every time; what did not fit is listed.
- **Finish levels:** rough (concrete, screed), pre-finish (white box) and finished (as chosen) — for the whole apartment, switched in the 3D HUD.
- **Light:** ☀ day / 🌇 sunset / 🌙 night with a smooth transition (key `N` cycles them), 💡 (key `L`) — lamps on / off; the walker's room gets the sun and shadows.
- **Photo textures notice:** when *Photo* is chosen, a note in the 3D view shows the loading progress (≈ 12 MB, n / total) and then "applied"; if the chosen finish needs a library set that is not on disk yet, the note offers **Download** / **Not now** — nothing is downloaded without the click.
- **Smooth on any device:** the 3D views draw only when something changes (0 frames when still), pause in a hidden tab, off screen or under a dialog; the quality tier (low / mid / high: pixel ratio, shadow maps, antialiasing, anisotropy) is picked from the CPU cores, memory and GPU name and stepped down when the frame rate drops (*3D quality*: Auto / High / Economy); textures are decoded off the main thread; walking, only the room you are in and the rooms behind open doors are drawn.
- **Texture library:** 41 CC0 sets (floor, wall, rough, furniture) from ambientCG, listed in `public/textures/library.json`; a set is downloaded on demand when first chosen, or all at once with `npm run textures` (`-- --kind floor`, `-- --id oakPlanks`).
- **3D apartment:** every room in one scene, one door per partition, walking from room to room (doors open by themselves, the doorway is checked for clearance).
- **New-building showcase** `/building.html` (🏢 in the header): a 12-storey demo building (plans in `buildings/chinor-park.json`, `node scripts/gen-building.mjs`; rooms, area, price and status of each apartment in `apartments.json`). The main view is the **3D building** made from the real apartment plans (`facade.js` → `bld3d/exterior.js`): warm travertine in 150 × 75 slabs, light frames in deep 25 cm reveals with soft shade, metal sills, balconies with glass rails at the living rooms, stone pilasters between apartments, a cornice and parapet, a dark stone ground floor with shop canopies and a canopy over the entrance, day / evening / night (smooth), a slow orbit. Behind every window there is a **room** (one shader, no extra geometry): walls, floor, ceiling, curtains or blinds, the sky reflected in the glass; in the evening and at night some rooms light up warm (on the low quality tier — plain glass). Hover a window — the apartment tooltip and a light frame round all its windows, click — its card, double click — fly to the floor; **🎨 Highlight** (off by default, remembered) frames the windows in the colour of the status or rooms with a light tint on the glass; filters darken the rest. Around it the **site** (`bld3d/site.js`): lawn, paths, street, parking with cars, playground, benches, lamps lit at night, ~40 trees — a trunk and boughs with bark and a crown of leaf cards whose shadows have the leaves' outline (on the low tier — simple trees). With the photo sets the lawn is photo grass without visible repetition, the road is asphalt, the paths are wave pavers. Also: filters (rooms, area, price, free only), a compact floor scheme, the floor plan with a tooltip, the apartment card (plan with furniture, rooms, area, price per m²). **🚶 Walk from the street** — first person on the site (the house, trees, benches and cars stop you) up to the entrance doors → the **lobby** (concierge, mailboxes, locked shops "for rent") → the **lift** (`E` at its doors — a panel with floors 1–12) or the **stairs** (± 1 floor) → the floor **corridor** with numbered doors: free and booked apartments can be entered (the apartment is swapped behind a short fade), sold ones stay locked; out through the lobby doors — back on the porch. From the card: **🚶 Walk through in 3D** — the same floor, starting at the apartment's entrance door (`/?embed=floor&b=…&apt=…`; a floor or the lobby: `/?embed=building&b=…&floor=N`); nothing is saved. **📐 Open in the planner** copies the apartment into a new project; **✉ Leave a request** sends an order with the apartment; the manager sets the apartment status in the order card (`PATCH /api/buildings/:id/apartments/:no`, admin token; statuses are kept in `data/`).
- **Languages:** EN / UZ / RU. Projects are kept in `localStorage`.

### Tech stack
Node.js + Express (static files + small JSON API), plain HTML/CSS/JS (ES modules, no build step), Canvas 2D, Three.js (npm + importmap).

### Getting started
```bash
npm install
npm start
```
Open http://localhost:3000 (Node.js 18+); the showcase is http://localhost:3000/building.html. Tests: `npm test`. Photo textures: `npm run textures` downloads the whole library (optional, sets are also fetched on demand). Building facade photos (travertine, black stone, concrete, timber) and the site (grass, asphalt, pavers, leaves, bark) are in the project (`public/textures/sets/`, ≈ 26 MB). Downloaded room sets go to `public/textures/lib/`, or to Vercel Blob when the project has a Blob store (`npm run textures -- --blob` fills it in advance).

**Manager page: sign-in by password.** Orders contain personal data (name, phone), so `/admin.html`, `/bookings.html` and `/calls.html` open only after the manager password:
1. `npm run admin-password -- --save` — type the password (hidden, at least 10 characters); only its scrypt hash goes to `.env` as `ADMIN_PASSWORD_HASH`. `.env` is not committed.
2. Restart `npm start`, open http://localhost:3000/admin.html and sign in. The browser gets an HttpOnly session cookie for 12 hours; «Sign out» ends it, a new password ends every session. 5 wrong passwords from one address → 15 minutes pause.
3. Without `ADMIN_PASSWORD_HASH` the pages say they are disabled. `ADMIN_TOKEN` (≥ 16 characters) stays for scripts: `Authorization: Bearer <token>` to the same API.

### Deploy to Vercel

1. Import the GitHub repository in Vercel (the Express app in `server.js` is detected by itself; `vercel.json` copies three.js into `public/vendor/three/` at build time and puts the functions in Frankfurt, `fra1`).
2. Storage → **Neon** (region Frankfurt, `eu-central-1`) — gives `DATABASE_URL`: orders, their pictures and apartment statuses go to Postgres, the tables are created on the first request.
3. Storage → **Blob** (public) — gives `BLOB_STORE_ID` (or `BLOB_READ_WRITE_TOKEN` for older stores): room texture sets downloaded on demand are kept there and served at the same `/textures/lib/` address (the CDN caches them). The facade and site sets are in the project.
4. The manager password: `npm run admin-password -- --vercel` sets `ADMIN_PASSWORD_HASH` (production). Optional: `ADMIN_TOKEN` (a long random string) for scripts.
5. Redeploy. Locally `vercel env pull` writes the variables to `.env.local` (not committed), `npm start` then uses the same database; `npm run textures -- --blob` fills Blob in advance.

Limits: an order is at most ≈ 4 MB (pictures are shrunk in the browser); own texture photos stay in the visitor's browser (IndexedDB). Without `DATABASE_URL` everything is kept in files, as in local work — on Vercel those files do not last.

### Controls
| Where | Action | How |
|---|---|---|
| 2D | Move | drag with mouse / finger |
| 2D | Rotate / delete / nudge | `R` / `Del` / arrows (`Shift` ×10) |
| 2D | Window / door | drag along the wall; `Del` / arrows when selected; 🔒 — lock |
| 2D | Undo / redo | `Ctrl+Z` / `Ctrl+Y` (`Ctrl+Shift+Z`) |
| 2D | Duplicate / select all | `Ctrl+D` / `Ctrl+A` |
| 2D | Multi-select | `Shift`/`Ctrl`+click, `Shift`+drag on the empty floor |
| 2D | Zoom / pan | wheel, pinch / drag the empty floor, `Space`+drag, middle button |
| 2D | Ruler | `M` or 📏; `Shift` — straight line; `Esc` — exit |
| 2D | Fill a niche | 📐, hover a wall, click; `Esc` — exit |
| 3D Overview | Rotate / zoom / pan | left mouse / wheel / right mouse |
| 3D Walk | Move | `W A S D` / arrows, `Shift` — faster |
| 3D Walk | Look | mouse (after click), or drag with the mouse if pointer lock is unavailable |
| 3D Walk | Exit | `Esc` |
| 3D | Open / close a door, drawer | click, `E` while walking; 🚪 — all |
| Mobile | Move / look | joystick / swipe |
| Apartment | Layout (move rooms) | ✥, `Esc` — exit |
| 3D | Lamps on / off | `L` or 💡 |
| 3D | Day → sunset → night | `N` |
| Floor in 3D | Neighbour's door / lift / stairs | `E` at the door (sold — locked); lift panel: floor buttons, `Esc` — close |
| Showcase 3D | Walk from the street | 🚶 button, `W A S D` / arrows, mouse (click to capture), touch: drag + ▲ ▼; `Esc` — back to the orbit |
| 3D | Day / sunset / night, finish level | HUD buttons ☀ 🌇 🌙, Rough / Pre-finish / Finished |

### Project structure
```
server.js            Express: static, catalog, templates, apartments, buildings, orders (+ drawing files), manager API, textures (list / upload / reset / ZIP / library)
server/              validateOrder (order check), orderStore (write queue, rate limit), buildings (apartment statuses), textureFetch, zip
orders/<id>/         order drawings plan.png / 3d.jpg (not in git)
.env.example         ADMIN_PASSWORD_HASH / ADMIN_TOKEN for the manager pages (copy to .env)
catalog.json         furniture catalogue (types, default sizes, names in 3 languages)
templates.json       room templates (Soviet-era / new build) and apartment sets
apartment-templates.json  apartment templates (khrushchevka / improved / new build)
apartments.json      new-building apartments: number, floor, rooms, area, price (sum), status free / booked / sold
buildings/           demo building for the showcase; data/ — apartment statuses (not in git)
scripts/             fetch-textures (npm run textures), gen-apartments, gen-building
order.json           saved orders
public/index.html    layout; building.html — new-building showcase; print.html — drawing + specification for printing / PDF; admin.html — manager page
public/css/          styles
public/js/           2D: state, geometry, openings, validate, renderer, interaction, autoplace, ui, i18n, storage, order,
                     history (undo), align, ruler, projects (rooms, tabs), projectsDialog, obstacles, catalog, zones, passages, templates,
                     snapshot, materials, matPanel, style, stylePanel, config, pricing, pricePanel, nicheTool, compare, drawing, admin,
                     apartment, kits, furnish, furnishUi, aptTemplates, lighting, walkMap, building, buildingPage, floor3d, facade
public/js/3d/        3D: scene3d, room3d, models3d, models3dMore, textures3d, lights3d, controls3d, touch3d, obstacles3d, anim3d, perf
public/js/bld3d/     showcase 3D: exterior (building), site (grounds), streetWalk (first person outside)
public/textures/     CC0 photo textures (ambientCG); lib/ — downloaded library sets (not in git)
test/                unit tests (node:test): npm test
```

### Rules
- All sizes are in centimetres; snap step 3–5 cm.
- Furniture is a rectangle on the plan; collisions use the footprint (AABB).
- Furniture must stay inside the room minus the plinth and must not overlap other items.

### Licences
Photo textures: [ambientCG](https://ambientcg.com) — CC0. Three.js — MIT.

---

## O‘zbekcha

Buyurtma asosida mebel uchun veb-ilova: mijoz xona va mebel o‘lchamlarini kiritadi, 2D rejada nima va qayerga sig‘ishini tekshiradi, xona bo‘ylab 3D’da sayr qiladi va buyurtma yuboradi.

### Imkoniyatlar
- **Xona:** uzunlik, kenglik, balandlik (sm); reja darhol qayta chiziladi.
- **Mebel (15 tur):** shkaf, karavot, divan, kreslo, stol, yozuv stoli, jurnal stolchasi, stul, tumba, komod, TV tumba, kitob javoni, poyabzal javoni, oshxona garnituri, muzlatgich — kenglik (X), chuqurlik (Y), balandlik (Z).
- **2D reja (Canvas, yuqoridan ko‘rinish):** avtomatik masshtab, 10/50 sm setka, plintus chekinishi (standart 2 sm). Masshtab o‘zgarmaydi: xabarlar o‘ng tomondagi alohida ustunda.
- **Masofalar** tanlangan buyumdan devorlargacha va oradagi mebelgacha: qo‘shni buyum tomonni to‘liq yopsa — faqat ungacha, qisman yopsa — ikkalasi (qo‘shnigacha va devorgacha).
- **Sudrab olib borish** setkaga (5 sm) bog‘lanish va devor/qo‘shni buyumlarga yopishish bilan; 0/90/180/270° burish (`R`), old tomon belgisi bilan.
- **Tekshiruv:** buyum **qizil** rangga bo‘yaladi, agar u devordan (plintus bilan) chiqib ketsa, boshqa buyum bilan kesishsa (AABB), minimal oraliqdan (3 sm) yaqin bo‘lsa, shiftdan baland bo‘lsa yoki eshik ochilishiga xalaqit bersa. Deraza oldidagi baland mebel — sariq ogohlantirish. Xabarlar ustuni har bir buyum uchun aniq sabablarni ko‘rsatadi.
- **Derazalar va eshiklar:** istalgan devorda istalgancha; rejada chiziladi (oyna, eshik tabaqasi va ochilish yoyi), devor bo‘ylab yoki boshqa devorga suriladi, yon panelda tahrirlanadi (chekinish, kenglik, balandlik, tokcha, oshiq-moshiq tomoni). 🔒 qulf ularni tasodifiy siljishdan himoya qiladi. 3D bilan sinxron va buyurtmada saqlanadi.
- **«Joy topish»:** bo‘sh joyni qidiradi (avval devorlar bo‘ylab, orqasi devorga, 4 burilish). Topilsa — yashil rang; topilmasa — aniq xabar, masalan: *«Sig‘maydi: janubiy devor bo‘ylab kenglik bo‘yicha 15 sm yetmaydi»*.
- **3D sahna (Three.js):** deraza, eshik va plintusli xona, protsedural mebel modellari, chiroq va kunduzgi yorug‘lik, soyalar bilan.
  - **Ko‘rinish** — kamera xona atrofida aylanadi, yaqin devorlar yashiriladi.
  - **Sayr** — birinchi shaxsdan, devor va mebel bilan to‘qnashuvlar; bo‘y 120–200 sm; pastdagi panel oyoqdan qaralayotgan buyum yoki devorgacha pol bo‘ylab masofani ko‘rsatadi.
  - **Oddiy / Foto** teksturalar (protsedural yoki CC0 foto-teksturalar). Sukut bo‘yicha — Foto (aniq kuchsiz qurilmalarda — Oddiy: dasturiy render, ≤ 2 yadro yoki ≤ 2 GB, eski telefon GPU’lari; va «Past» sifatda); tanlov eslab qolinadi. Pardoz uchun kerakli kutubxona to‘plamlarini server darhol yuklab oladi.
- **Foto-teksturalar paneli:** tayyor CC0 to‘plamni bir bosishda qo‘llash, uni yuklab olish (har bir sirt alohida yoki butun to‘plam ZIP’da) yoki pol, devorlar, mebel yog‘ochi va qoplama uchun o‘z rasmingizni yuklash (istalgan vaqtda tayyoriga qaytarish mumkin); o‘z rasmlaringiz brauzeringizda (IndexedDB) qoladi — boshqa tashrif buyuruvchilar ularni ko‘rmaydi.
  - To‘liq ekran rejimi, mobil qurilmalarda joystik.
- **Rejani tahrirlash:** bekor qilish / qaytarish (↶ ↷, `Ctrl+Z` / `Ctrl+Y`; butun sudrash — bitta qadam), nusxa olish (`Ctrl+D`), bir nechta tanlash (`Shift`/`Ctrl`+bosish, `Shift`+tortish — ramka, `Ctrl+A`), guruhni siljitish va **Tekislash / taqsimlash** paneli.
- **Masshtab va siljitish:** g‘ildirak kursor atrofida yaqinlashtiradi (50–800 %), − / 100 % / + tugmalari (100 % = sig‘dirish); bo‘sh polni tortish, `Probel`+tortish yoki o‘rta tugma bilan siljitish; sensorli ekranda ikki barmoq. Ko‘rinish saqlanmaydi.
- **Chizg‘ich** (📏 / `M`): ikki nuqtani bosing; nuqtalar devor, plintus va mebel chetlariga yopishadi, `Shift` chiziqni to‘g‘ri ushlaydi. Uzunlik va Δx / Δy ko‘rsatiladi; ⌫ — barcha o‘lchovlarni tozalash.
- **Konstruktiv:** «Derazalar, eshiklar va konstruktiv» panelida ustun, quti (stoyak), shift ostidagi quti, devor bo‘rtig‘i, radiator (deraza ostida markazda) yoki **tokcha** (devor qismining ikki yonidagi bo‘rtiqlar) qo‘shiladi. Rejada ular kulrang shtrixlangan va balandligi yozilgan, devorlarga yopishib suriladi, formada tahrirlanadi va o‘sha 🔒 qulf bilan himoyalanadi. Mebel o‘z balandligidagi konstruktiv bilan kesishmasligi kerak (`err.obstacle` va minimal oraliq); eshik ochilish zonasidagi yoki deraza oldidagi konstruktiv uchun ogohlantirish chiqadi. 3D da konstruktiv devor materialida, radiator seksiyali; boshdan baland bo‘lmasa, yurishga to‘sqinlik qiladi.
- **Osma mebel:** har bir buyumda «Poldan» (`elev`, sm) bor. To‘qnashuvlar uch o‘q bo‘yicha: stol ustidagi tokcha — xato emas, shift ostidagi quti ostidagi shkaf uning pastki qismi bo‘yicha tekshiriladi, eshik zonasidagi tokcha faqat eshik balandligidan past bo‘lsa xato. Rejada osma buyumlar pol buyumlari ustida chiziladi (shaffof, punktir, «↑140»); bosish yuqoridagini tanlaydi, xuddi shu joyga yana bosish — pastdagini. Katalogdagi yangi turlar: osma shkaf, devor tokchasi, antresol, osma TV konsol, devor oynasi.
- **Ochilish zonalari:** shkaf, komod, oshxona, muzlatgich va osma shkaflar qanday ochilishini biladi (ochiladigan eshiklar, kupe, tortmalar, yoyiladigan; buyumda eshiklar soni bilan o‘zgartirish mumkin). Eshik yoki tortma o‘z balandligidagi devor, mebel yoki konstruktivga tegsa — yetishmaydigan sm bilan xato: «Eshikcha/tortma ochilmaydi: «Karavot» xalaqit beradi (20 sm yetmaydi)». Bir joydagi ikki zona yoki xona eshigi zonasidagi zona — ogohlantirish. **⌓ Zonalar** (`Z` tugmasi) almashadi: faqat tanlangan → hammasi → yashirin; tekshiruv har doim ishlaydi, zona xatosi bor tanlangan buyum zonasi doim ko‘rinadi. Avtojoylashtirish avval zonasi bo‘sh joyni qidiradi.
- **O‘tish joylari:** mebel, konstruktiv va devorlar orasidagi me’yordan tor oraliqlar («O‘tish joyi» sozlamasi, standart 60 sm; 20 sm dan kichigi — tirqish) ogohlantiriladi: «Tor o‘tish joyi 48 sm (me’yor 60 dan)». **↔ O‘tishlar** (`P` tugmasi) rejadagi sariq chiziqlarni ko‘rsatadi / yashiradi, nishonda soni; xabarlar ustunida yig‘iladigan «O‘tish joylari (N)» guruhi, bosilganda o‘tish joyi rejada yonadi.
- **Loyihalar va xonalar:** loyihada bir nechta xona bor, ular reja ustida yorliqlar ko‘rinishida (+ Xona: nomi, vazifasi, o‘lchami; ⋯ — nomini o‘zgartirish, «variant B» versiyasi sifatida nusxalash, o‘chirish). Har bir xonaning o‘z bekor qilish tarixi bor. 📁 **Loyihalar** — reja rasmi bilan kartalar: ochish, yangi, nomini o‘zgartirish, nusxalash, o‘chirish, `.fsp3d.json` faylga **eksport / import** (zaxira yoki boshqa qurilmaga ko‘chirish). Eski bitta xonali reja avtomatik ravishda «Mening loyiham»ga ko‘chiriladi.
- **Xona shablonlari:** + Xona → **Shablondan**: *Sovet davri uyi* to‘plami (panel / g‘isht 1960–90-yillar, shift ≈ 2,8 m) yoki *Yangi bino* (monolit/karkas 2015+, shift ≈ 3,0 m) — yotoqxona, bolalar xonasi, oshxona-mehmonxona, asosiy yotoqxona, zal (sovet uyida ikki eshikli o‘tish xona), katta yotoqxona, ish xonasi, oshxona. Har bir kartada kichik reja va «12 m² · 4×3 m». Shablonda derazalar (tagida radiator), eshiklar, konstruktiv (stoyak, devor chiqig‘i, kolonna) va xatosiz joylashtirilgan mebel bor; keyin hammasini o‘zgartirish mumkin. 📁 Loyihalar → **Kvartira shablonidan yangi loyiha**: «2 xonali (sovet)» = zal + yotoqxona + oshxona, «3 xonali (yangi bino)» = oshxona-mehmonxona + asosiy yotoqxona + bolalar xonasi, har bir xona alohida yorliqda. O‘lchamlar Toshkent uylari uchun odatiy; shablonlar `templates.json` da (`GET /api/templates`).
- **3D ko‘rinish:** 📷 *Surat* PNG (2× aniqlik) ni xulosa plashkasi bilan saqlaydi — loyiha, xona, vazifasi, o‘lcham va maydon, buyumlar soni, sana; telefonda ⤴ *Ulashish*; chizg‘ich yonidagi 📷 rejani saqlaydi. Har bir buyumga katalogdan **material** (eman, yong‘oq, oq shumtol, oq mat, grafit, shalfey, yaltiroq, matolar, velyur) — shkaf, komod, oshxona va h.k. uchun **korpus va fasad** alohida — yoki o‘z rangi. **Yorug‘lik:** ☀ kunduz / 🌇 kechqurun (past iliq quyosh, chiroqlar yoniq) / 🌙 tun (qorong‘i deraza, faqat chiroqlar) va shift chirog‘i: qandil, nuqtali, LED panel yoki yo‘q — har bir xonada bir xil, real yorqinlikdagi chiroqlar (nuqtali — tor konus, yorug‘lik devordan o‘tmaydi); **Yumshoq soyalar** (sukut bo‘yicha yoqilgan) har bir mebel ostiga yumshoq soya va xona burchaklariga soya beradi — istalgan burchakdan barqaror, har qanday qurilmada (ekran AO o‘rniga); katalogda o‘z yorug‘ligi bor torsher va devor chirog‘i. **Pardoz** (Xona → *Pardoz va uslub*): devorlar — bo‘yoq, gulqog‘oz, g‘isht, panellar + rang, alohida rangdagi urg‘u devori, pol — parket, laminat, kafel, gilam qoplama; **mebel uslubi** modern / klassika (latun tutqichlar, yo‘nilgan oyoqlar, naqshli fasadlar) / loft (qora po‘lat) butun xona yoki bitta buyum uchun — o‘lchamlar va to‘qnashuvlar o‘zgarmaydi. Yorug‘lik va pardoz xona bilan saqlanadi va bekor qilinadi.
- **3D da ochish:** shkaf, komod, oshxona, muzlatgich yoki xona eshigini bosing (yurishda `E`) — eshikchalar ochiladi, tortmalar chiqadi, qopqoqlar tushadi; 🚪 *Hammasini ochish* / *yopish*. Har kadrda harakatlanuvchi qism boshqa mebel, konstruktiv va devorlar bilan tekshiriladi: tegsa qizaradi, to‘xtaydi va HUD «Eshikcha «Karavot»ga tegadi: 64°» deb yozadi.
- **Konfigurator va taxminiy narx:** shkaf, komod, tumba, poyabzal javoni va oshxonada *Seksiyalar* va *Tortmalar* bor (kupe shkafda — 2–3 eshik); 3D model ularga mos quriladi (ichi bo‘sh korpus, to‘siqlar, javonlar, ilgich, tortmalar), rejada seksiyalar shtrix chiziq bilan ko‘rsatiladi. Tanlangan buyumda «≈ 2 310 000 so‘m» (ustiga olib boring — tafsilot: korpus, fasad, eshiklar, furnitura…), mebel ro‘yxatida — «Jami taxminan … dan»; jami surat plashkasiga va buyurtmaga ham tushadi. **`catalog.json` → `pricing` va `materials[].priceRate` dagi narxlar SINOV uchun — ishga tushirishdan oldin haqiqiylariga almashtiring.**
- **Tokchani to‘ldirish** (📐): devorga olib boring — u yerga sig‘adigan eng katta shkafning yashil «sharpasi» (plintus va oraliqlar hisobga olinadi, oldida o‘tish joyi qoladi, shift yoki shift ostidagi qutidan 5 sm past); bosing — tanlang, kupe yoki ochiladigan eshiklarni narxi bilan tanlang, *Qo‘llash* sozlangan shkafni bitta bekor qilish qadami sifatida qo‘shadi.
- **Variantlarni solishtirish:** xona yorlig‘i ⋯ → *Solishtirish…* — loyihaning ikki xonasi yonma-yon (faqat ko‘rish) o‘lcham, buyumlar soni, xatolar va narx bilan; standart bo‘yicha — shu xonaning boshqa varianti.
- **Buyurtma chizmasi:** buyurtmaga chizma qo‘shiladi — reja standart masshtabda 1:N oq A4 varag‘ida (2400 px): raqamlangan buyumlar, ularning o‘lchamlari va devorlargacha masofalar, derazalar, eshiklar, konstruktiv va shtamp (loyiha, xona, o‘lchamlar, masshtab, narx, buyurtma №, sana); 3D ko‘rinish ochiq bo‘lsa — 3D surat ham. Server ularni `orders/<id>/plan.png` (`3d.jpg`) ga saqlaydi. Buyurtma formasidagi **🖨 Chizma / PDF** `print.html` ni ochadi: chizma va spetsifikatsiya (№, nomi, gabarit, poldan balandlik, material va konfiguratsiya, narx) → *Chop etish / PDF* → «PDF sifatida saqlash», kutubxonalarsiz.
- **Buyurtma** — forma (ism, telefon, izoh) loyiha va xona nomi bilan `order.json` fayliga saqlanadi; «barcha xonalarni yuborish» belgisi loyihaning hamma xonalarini yuboradi (har birida xato bo‘lmasligi kerak). Server har bir buyurtmani tekshiradi (`server/validateOrder.js`: maydonlar oq ro‘yxati, diapazonlar — o‘lchamlar 50–3000 sm, ≤ 200 buyum, ≤ 50 ochiq joy / konstruktiv, telefon niqobi, chizma uchun PNG imzosi va ≤ 2 MB), bitta IP dan 10 daqiqada 5 ta buyurtmaga ruxsat beradi (aks holda «Juda tez-tez»), yashirin `website` maydonini to‘ldirgan botlarni jimgina tashlab yuboradi va `order.json` ni navbat orqali yozadi (vaqtinchalik fayl + rename) — parallel buyurtmalar yo‘qolmaydi.
- **Menejer sahifasi** `/admin.html` (pastga qarang): buyurtmalar jadvali — №, sana, ism, telefon (`tel:` havola), loyiha / xona, summa, holat; holat bo‘yicha filtr va qidiruv; holatlar **yangi → ishda → o‘lchov → tayyor** (+ bekor qilingan) sanali tarix bilan; buyurtma kartasida chizma, 3D surat, spetsifikatsiya, mijoz izohi va menejer izohlari.
- **Butun kvartira:** loyiha — bitta kvartira, xonalari bitta rejada; umumiy to‘siqdagi (10 sm) eshik qo‘shni xonaga olib boradi. Sarlavhada maydon, faol xona va **⎘ Variantlar** (butun kvartira nusxalari). **✥ Planirovka** — xonalarni suring, ular qo‘shnisiga to‘siq orqali yopishadi (`Esc` — chiqish). Mebelni bir xonadan boshqasiga sudrab o‘tkazish mumkin. Eski bir xonali loyihalar avtomatik ko‘chiriladi.
- **Kvartira shablonlari:** 📁 Loyihalar → *Shablondan kvartira* — *xrushchyovka* (1-447, 1-464, II-29 seriyalari), *yaxshilangan planirovka* (1-528, II-49, II-57, 121) va *yangi bino* (studiya, yevro-2, 2–4 xonali), bo‘sh yoki mebel bilan (`apartment-templates.json`, `GET /api/apartments`).
- **To‘plamlar:** 🎲 *Jihozlash* xona vazifasiga ko‘ra tayyor to‘plamni joylaydi (yotoqxona, bolalar xonasi, zal, oshxona, kabinet, dahliz, hammom…) — bitta xona yoki butun kvartira, har safar yangi variant; sig‘maganlari ro‘yxatda ko‘rsatiladi.
- **Pardoz darajalari:** qora (beton, styajka), oldindan pardoz (white box) va toza (tanlanganidek) — butun kvartira uchun, 3D HUD’da almashtiriladi.
- **Yorug‘lik:** ☀ kun / 🌇 shom / 🌙 tun silliq o‘tish bilan (`N` tugmasi navbat bilan almashtiradi), 💡 (`L` tugmasi) — chiroqlarni yoqish / o‘chirish; yuruvchi turgan xonaga quyosh va soyalar beriladi.
- **Foto-teksturalar haqida xabar:** *Foto* tanlanganda 3D ko‘rinishda yuklanish jarayoni (≈ 12 MB, n / jami), so‘ng «qo‘llandi» ko‘rsatiladi; tanlangan pardoz uchun diskda yo‘q kutubxona to‘plami kerak bo‘lsa — **Yuklab olish** / **Hozir emas** tugmalari; bosilmasa hech narsa yuklanmaydi.
- **Har qanday qurilmada silliq:** 3D faqat nimadir o‘zgarganda chiziladi (tinch holatda 0 kadr), yashirin vkladka, ekrandan tashqarida yoki dialog ostida to‘xtaydi; sifat darajasi (past / o‘rta / yuqori: piksel zichligi, soya xaritalari, silliqlash, anizotropiya) protsessor yadrolari, xotira va GPU nomi bo‘yicha tanlanadi va kadrlar tushsa pasaytiriladi (*3D sifati*: Avto / Yuqori / Tejamkor); teksturalar asosiy oqimdan tashqarida ochiladi; sayrda faqat turgan xona va ochiq eshiklar ortidagi xonalar chiziladi.
- **Teksturalar kutubxonasi:** ambientCG’dan 41 ta CC0 to‘plam (pol, devor, qora pardoz, mebel), ro‘yxati `public/textures/library.json`da; to‘plam birinchi tanlanganda yuklanadi yoki hammasi birdan `npm run textures` bilan (`-- --kind floor`, `-- --id oakPlanks`).
- **3D kvartira:** barcha xonalar bitta sahnada, har bir to‘siqda bitta eshik, xonadan xonaga yurish (eshiklar o‘zi ochiladi, eshik o‘tish joyi tekshiriladi).
- **Yangi bino vitrinasi** `/building.html` (sarlavhadagi 🏢): 12 qavatli demo bino (rejalar `buildings/chinor-park.json`da, `node scripts/gen-building.mjs`; har bir kvartiraning xonalari, maydoni, narxi va holati `apartments.json`da). Holat bo‘yicha bo‘yalgan qavatli fasad (bo‘sh / band / sotilgan), filtrlar (xonalar, maydon, narx, faqat bo‘shlari), izohli qavat rejasi, kvartira kartochkasi (mebelli reja, xonalar, maydon, 1 m² narxi). Asosiy ko‘rinish — haqiqiy kvartira rejalaridan qurilgan **3D bino** (`facade.js` → `bld3d/exterior.js`): 150 × 75 plitali iliq travertin, yumshoq soyali chuqur 25 sm qiyaliklardagi och romlar, metall tokchalar, mehmonxonalarda shisha to‘siqli balkonlar, kvartiralar orasida tosh pilyastrlar, karniz va parapet, do‘kon soyabonlari va kirish ustida soyabonli qora toshli birinchi qavat, kun / kechqurun / tun (silliq), sekin aylanish. Har bir deraza ortida **xona** bor (bitta sheyder, qo‘shimcha geometriyasiz): devorlar, pol, shift, parda yoki jalyuzi, oynada osmon aksi; kechqurun va tunda ba’zi xonalarda iliq chiroq yonadi (past sifat darajasida — oddiy oyna). Derazaga olib borish — kvartira izohi va uning barcha derazalari atrofida och rom, bosish — kartochka, ikki marta bosish — qavatga uchish; **🎨 Rang** (sukut bo‘yicha o‘chiq, eslab qolinadi) derazalarni holat yoki xonalar rangidagi rom va oynadagi yengil tus bilan ajratadi; filtrlar qolganini qoraytiradi. Atrofida **hovli** (`bld3d/site.js`): maysazor, yo‘laklar, ko‘cha, mashinali avtoturargoh, bolalar maydonchasi, skameykalar, tunda yonadigan chiroqlar, ~40 daraxt — po‘stloqli tana va shoxlar, barg kartochkalaridan toj, soyasi barglar shaklida (past darajada — oddiy daraxtlar). Foto-to‘plamlar bilan maysazor takrorlanishi sezilmaydigan foto-o‘t, ko‘cha — asfalt, yo‘laklar — «to‘lqin» plitka. **🚶 Ko‘chadan sayr** — hovlida birinchi shaxs (bino, daraxtlar, skameykalar, mashinalar to‘sadi) podyezd eshigigacha → **lobbi** (konsyerj, pochta qutilari, yopiq «ijara» do‘konlari) → **lift** (eshigida `E` — 1–12 qavat tugmalari) yoki **zinapoya** (± 1 qavat) → raqamli eshiklari bor qavat **yo‘lagi**: bo‘sh va band qilingan kvartiralarga kirish mumkin (qisqa qorong‘ilashuv bilan almashtiriladi), sotilganlari yopiq; lobbi eshigidan chiqish — yana ayvonda. Kartochkadan: **🚶 3D’da aylanib chiqish** — o‘sha qavat, kvartiraning kirish eshigidan (`/?embed=floor&b=…&apt=…`; qavat yoki lobbi: `/?embed=building&b=…&floor=N`); hech narsa saqlanmaydi. **📐 Rejalashtiruvchida ochish** kvartirani yangi loyihaga nusxalaydi; **✉ Ariza qoldirish** kvartira bilan buyurtma yuboradi; menejer buyurtma kartochkasida kvartira holatini o‘zgartiradi (`PATCH /api/buildings/:id/apartments/:no`, admin token; holatlar `data/`da saqlanadi).
- **Tillar:** EN / UZ / RU. Loyihalar `localStorage`da saqlanadi.

### Texnologiyalar
Node.js + Express (statik fayllar + kichik JSON API), oddiy HTML/CSS/JS (ES modullar, yig‘ishsiz), Canvas 2D, Three.js (npm + importmap).

### Ishga tushirish
```bash
npm install
npm start
```
http://localhost:3000 manzilini oching (Node.js 18+); vitrina — http://localhost:3000/building.html. Testlar: `npm test`. Foto-teksturalar: `npm run textures` butun kutubxonani yuklaydi (ixtiyoriy, to‘plamlar kerak bo‘lganda ham yuklanadi). Bino fasadi fotolari (travertin, qora tosh, beton, yog‘och) va hovli (o‘t, asfalt, plitka, barglar, po‘stloq) loyihada (`public/textures/sets/`, ≈ 26 MB). Yuklangan xona to‘plamlari `public/textures/lib/`ga, loyihada Blob ombori bo‘lsa esa Vercel Blob’ga tushadi (`npm run textures -- --blob` uni oldindan to‘ldiradi).

**Menejer sahifasi: parol bilan kirish.** Buyurtmalarda shaxsiy ma’lumotlar (ism, telefon) bor, shuning uchun `/admin.html`, `/bookings.html` va `/calls.html` faqat menejer paroli bilan ochiladi:
1. `npm run admin-password -- --save` — parolni kiriting (yashirin, kamida 10 belgi); `.env`ga faqat uning scrypt xeshi `ADMIN_PASSWORD_HASH` sifatida yoziladi. `.env` git ga tushmaydi.
2. `npm start` ni qayta ishga tushiring, http://localhost:3000/admin.html ni oching va kiring. Brauzer 12 soatlik HttpOnly sessiya cookie oladi; «Chiqish» uni tugatadi, yangi parol barcha sessiyalarni tugatadi. Bitta manzildan 5 ta noto‘g‘ri parol → 15 daqiqa tanaffus.
3. `ADMIN_PASSWORD_HASH` bo‘lmasa sahifalar o‘chirilganini aytadi. `ADMIN_TOKEN` (≥ 16 belgi) skriptlar uchun qoladi: o‘sha API’ga `Authorization: Bearer <token>`.

### Vercel’ga joylash

1. GitHub repozitoriyasini Vercel’ga import qiling (`server.js`dagi Express ilovasi o‘zi aniqlanadi; `vercel.json` qurishda three.js’ni `public/vendor/three/`ga ko‘chiradi va funksiyalarni Frankfurtga, `fra1`, qo‘yadi).
2. Storage → **Neon** (Frankfurt mintaqasi, `eu-central-1`) — `DATABASE_URL` beradi: arizalar, ularning rasmlari va kvartira holatlari Postgres’da, jadvallar birinchi so‘rovda yaratiladi.
3. Storage → **Blob** (public) — `BLOB_STORE_ID` (eski omborlarda `BLOB_READ_WRITE_TOKEN`) beradi: kerak bo‘lganda yuklanadigan xona teksturalari shu yerda saqlanadi va o‘sha `/textures/lib/` manzilida beriladi (CDN keshlaydi). Fasad va hovli to‘plamlari loyihada.
4. Menejer paroli: `npm run admin-password -- --vercel` `ADMIN_PASSWORD_HASH` ni (production) o‘rnatadi. Ixtiyoriy: skriptlar uchun `ADMIN_TOKEN` (uzun tasodifiy satr).
5. Qayta deploy qiling. Lokal ravishda `vercel env pull` o‘zgaruvchilarni `.env.local`ga yozadi (commit qilinmaydi), shunda `npm start` o‘sha bazadan foydalanadi; `npm run textures -- --blob` Blob’ni oldindan to‘ldiradi.

Cheklovlar: ariza ≈ 4 MB gacha (rasmlar brauzerda kichraytiriladi); o‘z tekstura fotolaringiz tashrif buyuruvchining brauzerida qoladi (IndexedDB). `DATABASE_URL` bo‘lmasa hammasi lokal ishdagidek fayllarda saqlanadi — Vercel’da bu fayllar saqlanib qolmaydi.

### Boshqaruv
| Qayerda | Amal | Qanday |
|---|---|---|
| 2D | Siljitish | sichqoncha / barmoq bilan sudrash |
| 2D | Burish / o‘chirish / siljitish | `R` / `Del` / strelkalar (`Shift` ×10) |
| 2D | Deraza / eshik | devor bo‘ylab sudrash; tanlanganda `Del` / strelkalar; 🔒 — qulf |
| 2D | Bekor qilish / qaytarish | `Ctrl+Z` / `Ctrl+Y` (`Ctrl+Shift+Z`) |
| 2D | Nusxa / hammasini tanlash | `Ctrl+D` / `Ctrl+A` |
| 2D | Bir nechta tanlash | `Shift`/`Ctrl`+bosish, bo‘sh polda `Shift`+tortish |
| 2D | Masshtab / siljitish | g‘ildirak, ikki barmoq / bo‘sh polni tortish, `Probel`+tortish, o‘rta tugma |
| 2D | Chizg‘ich | `M` yoki 📏; `Shift` — to‘g‘ri chiziq; `Esc` — chiqish |
| 2D | Tokchani to‘ldirish | 📐, devorga olib boring, bosing; `Esc` — chiqish |
| 3D Ko‘rinish | Aylantirish / masshtab / surish | chap tugma / g‘ildirak / o‘ng tugma |
| 3D Sayr | Yurish | `W A S D` / strelkalar, `Shift` — tezroq |
| 3D Sayr | Qarash | sichqoncha (bosgandan keyin) yoki kursor qulflanmasa — sichqonchani bosib surish |
| 3D Sayr | Chiqish | `Esc` |
| 3D | Eshik, tortmani ochish / yopish | bosish, yurishda `E`; 🚪 — hammasi |
| Mobil | Yurish / qarash | joystik / ekranni surish |
| Kvartira | Planirovka (xonalarni surish) | ✥, `Esc` — chiqish |
| 3D | Chiroqlarni yoqish / o‘chirish | `L` yoki 💡 |
| 3D | Kun → shom → tun | `N` |
| Qavat 3D’da | Qo‘shni eshigi / lift / zinapoya | eshik oldida `E` (sotilgan — yopiq); lift paneli: qavat tugmalari, `Esc` — yopish |
| Vitrina 3D | Ko‘chadan sayr | 🚶 tugmasi, `W A S D` / strelkalar, sichqoncha (bosish — ushlash), sensor: surish + ▲ ▼; `Esc` — aylanishga qaytish |
| 3D | Kun / shom / tun, pardoz darajasi | HUD tugmalari ☀ 🌇 🌙, Qora / Oldindan / Toza |

### Loyiha tuzilmasi
```
server.js            Express: statik, katalog, shablonlar, kvartiralar, binolar, buyurtmalar (+ chizma fayllari), menejer API, teksturalar (ro‘yxat / yuklash / tiklash / ZIP / kutubxona)
server/              validateOrder (buyurtmani tekshirish), orderStore (yozish navbati, chastota limiti), buildings (kvartira holatlari), textureFetch, zip
orders/<id>/         buyurtma chizmalari plan.png / 3d.jpg (git da yo‘q)
.env.example         menejer sahifalari uchun ADMIN_PASSWORD_HASH / ADMIN_TOKEN (.env ga nusxalang)
catalog.json         mebel katalogi (turlar, standart o‘lchamlar, 3 tildagi nomlar)
templates.json       xona shablonlari (sovet uyi / yangi bino) va kvartira to‘plamlari
apartment-templates.json  kvartira shablonlari (xrushchyovka / yaxshilangan / yangi bino)
apartments.json      yangi bino kvartiralari: raqam, qavat, xonalar, maydon, narx (so‘m), holat free / booked / sold
buildings/           vitrina uchun demo bino; data/ — kvartira holatlari (git’da emas)
scripts/             fetch-textures (npm run textures), gen-apartments, gen-building
order.json           saqlangan buyurtmalar
public/print.html    chop etish / PDF uchun chizma + spetsifikatsiya; public/admin.html — menejer sahifasi
public/index.html    sahifa tuzilmasi; building.html — yangi bino vitrinasi
public/css/          uslublar
public/js/           2D: state, geometry, openings, validate, renderer, interaction, autoplace, ui, i18n, storage, order,
                     history (bekor qilish), align, ruler, projects (xonalar, yorliqlar), projectsDialog, obstacles, catalog, zones, passages, templates,
                     snapshot, materials, matPanel, style, stylePanel, config, pricing, pricePanel, nicheTool, compare, drawing, admin,
                     apartment, kits, furnish, furnishUi, aptTemplates, lighting, walkMap, building, buildingPage, floor3d, facade
public/js/3d/        3D: scene3d, room3d, models3d, models3dMore, textures3d, lights3d, controls3d, touch3d, obstacles3d, anim3d, perf
public/js/bld3d/     showcase 3D: exterior (building), site (grounds), streetWalk (first person outside)
public/textures/     CC0 foto-teksturalar (ambientCG); lib/ — yuklab olingan kutubxona to‘plamlari (git’da emas)
test/                unit testlar (node:test): npm test
```

### Qoidalar
- Barcha o‘lchamlar santimetrda; bog‘lanish qadami 3–5 sm.
- Mebel rejada to‘rtburchak; to‘qnashuvlar gabarit (AABB) bo‘yicha.
- Mebel plintusni hisobga olgan holda xonadan chiqmasligi va boshqa buyumlar bilan kesishmasligi kerak.

### Litsenziyalar
Foto-teksturalar: [ambientCG](https://ambientcg.com) — CC0. Three.js — MIT.

---

## Русский

Веб-приложение для мебели на заказ: клиент задаёт размеры комнаты и мебели, проверяет на 2D-плане, что поместится и где, гуляет по комнате в 3D и отправляет заявку.

### Возможности
- **Комната:** длина, ширина, высота (см); план перестраивается мгновенно.
- **Мебель (15 видов):** шкаф, кровать, диван, кресло, стол, письменный стол, журнальный столик, стул, тумба, комод, ТВ-тумба, стеллаж, обувница, кухонный гарнитур, холодильник — ширина (X), глубина (Y), высота (Z).
- **2D-план (Canvas, вид сверху):** автомасштаб, сетка 10/50 см, отступ плинтуса (по умолчанию 2 см). Масштаб не меняется: сообщения выводятся в отдельной колонке справа.
- **Расстояния** от выбранного предмета до стен и до мебели между ним и стеной: если сосед закрывает сторону целиком — только до него, если частично — оба (до соседа и до стены).
- **Drag & drop** с привязкой к сетке (5 см) и «магнитом» к стенам и соседям; поворот 0/90/180/270° (`R`) с маркером лицевой стороны.
- **Валидация:** предмет подсвечивается **красным**, если выходит за стену (с учётом плинтуса), пересекается с другим предметом (AABB), стоит ближе минимального зазора (3 см), выше потолка или мешает открыванию двери. Высокая мебель перед окном — жёлтое предупреждение. Колонка уведомлений показывает точные причины по каждому предмету.
- **Окна и двери:** любое количество на любой стене; видны на плане (стекло, полотно и дуга открывания), перетаскиваются вдоль стены или на другую, редактируются в боковой панели (отступ, ширина, высота, подоконник, сторона петель). Замок 🔒 защищает их от случайного сдвига при расстановке мебели. Синхронизированы с 3D и сохраняются в заявке.
- **«Найти место»:** перебор свободных позиций (сначала вдоль стен, спинкой к стене, 4 поворота). Найдено — зелёная подсветка; не найдено — точное сообщение, например: *«Не помещается: не хватает 15 см по ширине вдоль южной стены»*.
- **3D-сцена (Three.js):** комната с окном, дверью и плинтусами, процедурные модели мебели, лампа и дневной свет с тенями.
  - **Обзор** — камера вокруг комнаты, ближние стены скрываются.
  - **Прогулка** — от первого лица, столкновения со стенами и мебелью; рост человека 120–200 см; внизу — расстояние по полу от ног до предмета или стены, куда смотрит пользователь.
  - Текстуры **Простые / Фото** (процедурные или фото-текстуры CC0). По умолчанию — Фото (на очевидно слабых устройствах — Простые: программный рендер, ≤ 2 ядер или ≤ 2 ГБ, старые GPU телефонов; и при качестве «Низкое»); выбор запоминается. Нужные отделке наборы библиотеки сервер скачивает сразу.
- **Панель «Фото-текстуры»:** готовый набор CC0 применяется в один клик, его можно скачать (по поверхностям или весь набор ZIP) или загрузить своё фото для пола, стен, дерева мебели или обивки (в любой момент можно вернуть готовую); свои фото остаются в вашем браузере (IndexedDB) — другие посетители их не видят.
  - Полноэкранный режим, джойстик на мобильных.
- **Правка плана:** отмена / повтор (↶ ↷, `Ctrl+Z` / `Ctrl+Y`; всё перетаскивание — один шаг), дублирование (`Ctrl+D`), выделение нескольких (`Shift`/`Ctrl`+клик, `Shift`+протяжка — рамка, `Ctrl+A`), перемещение группы и панель **Выровнять / распределить**.
- **Масштаб и сдвиг:** колесо приближает относительно курсора (50–800 %), кнопки − / 100 % / + (100 % = вписать); сдвиг — протяжкой по пустому полу, `Пробел`+протяжка или средней кнопкой; на тач-экране — щипок. Вид не сохраняется.
- **Линейка** (📏 / `M`): клик по двум точкам; точки притягиваются к стенам, плинтусу и краям мебели, `Shift` держит линию ровной. Показывает длину и Δx / Δy; ⌫ — очистить все измерения.
- **Конструктив:** в панели «Окна, двери и конструктив» добавляются колонна, короб (стояк), короб под потолком, выступ стены, батарея (по центру под окном) или **ниша** (два выступа по бокам участка стены). На плане они заштрихованы серым с подписью высоты, перетаскиваются с прилипанием к стенам, редактируются в форме и защищены тем же замком 🔒. Мебель не должна пересекаться с конструктивом на своей высоте (`err.obstacle`, плюс минимальный зазор); конструктив в зоне двери или перед окном даёт предупреждение. В 3D конструктив в материале стены, батарея секционная; в прогулке мешает, если не выше головы.
- **Навесная мебель:** у каждого предмета есть «От пола» (`elev`, см). Коллизии по трём осям: полка над столом — не ошибка, шкаф под коробом под потолком проверяется по его низу, полка в зоне двери — ошибка, только если ниже верха двери. На плане навесные предметы рисуются поверх напольных (полупрозрачно, пунктир, «↑140»); клик выбирает верхний предмет, повторный клик в ту же точку — нижний. Новые типы каталога: навесной шкаф, настенная полка, антресоль, подвесная ТВ-консоль, настенное зеркало.
- **Зоны открывания:** шкафы, комоды, кухня, холодильник и навесные шкафы знают, как открываются (распашные двери, купе, ящики, раскладной; можно поменять у предмета, вместе с числом дверей). Если дверца или ящик упирается в стену, мебель или конструктив на своей высоте — ошибка с нехваткой: «Дверца/ящик не откроется: мешает «Кровать» (не хватает 20 см)». Две зоны на одном месте или зона в зоне двери комнаты — предупреждение. **⌓ Зоны** (клавиша `Z`) по кругу: только выбранный → все → скрыты; проверки работают в любом режиме, у выбранного предмета с ошибкой зона видна всегда. Автоподбор сначала ищет место со свободной зоной.
- **Проходы:** промежутки между мебелью, конструктивом и стенами уже нормы (настройка «Проход от», 60 см по умолчанию; меньше 20 см — щель, а не проход) дают предупреждение: «Узкий проход 48 см (норма от 60)». **↔ Проходы** (клавиша `P`) показывает / скрывает жёлтые полосы на плане, бейдж — их число; в колонке уведомлений сворачиваемая группа «Проходы (N)», клик подсвечивает проход на плане.
- **Проекты и комнаты:** в проекте несколько комнат — вкладки над планом (+ Комната: название, назначение, размеры; ⋯ — переименовать, дублировать как версию «вариант Б», удалить). У каждой комнаты своя история отмены. 📁 **Проекты** — карточки с превью плана: открыть, новый, переименовать, дублировать, удалить, **экспорт / импорт** файла `.fsp3d.json` (резервная копия или перенос на другое устройство). Старый план одной комнаты автоматически переносится в «Мой проект».
- **Шаблоны комнат:** + Комната → **Из шаблона**: набор *Советский дом* (панель / кирпич 1960–90-х, потолок ≈ 2,8 м) или *Новостройка* (монолит/каркас 2015+, потолок ≈ 3,0 м) — спальня, детская, кухня-гостиная, мастер-спальня, зал (в советском — проходной с двумя дверями), большая спальня, кабинет, кухня. На карточке мини-план и «12 м² · 4×3 м». В шаблоне окна с батареями под ними, двери, конструктив (стояки, выступ, колонна) и мебель, расставленная без ошибок; дальше всё можно менять. 📁 Проекты → **Новый проект из шаблона квартиры**: «2-комнатная (сов.)» = зал + спальня + кухня, «3-комнатная (новостройка)» = кухня-гостиная + мастер-спальня + детская, каждая комната — своей вкладкой. Размеры типичные для жилья Ташкента; шаблоны лежат в `templates.json` (`GET /api/templates`).
- **Вид в 3D:** 📷 *Снимок* сохраняет PNG (2× разрешение) с плашкой-сводкой — проект, комната, назначение, размеры и площадь, число предметов, дата; на телефоне ⤴ *Поделиться*; 📷 рядом с линейкой сохраняет план. У каждого предмета **материал** из каталога (дуб, орех, ясень, белый матовый, графит, шалфей, глянец, ткани, велюр) — у шкафов, комодов, кухни и т. п. отдельно **корпус и фасад** — или свой цвет. **Свет:** ☀ день / 🌇 вечер (низкое тёплое солнце, лампы включены) / 🌙 ночь (тёмное окно, только светильники) и потолочный свет: люстра, точечные, LED-панель или без него — во всех комнатах одинаковые светильники с реалистичной яркостью (точечные — узкий конус, свет не проходит сквозь стены); **Мягкие тени** (включены по умолчанию) дают мягкое пятно под каждым предметом мебели и затенение углов комнаты — стабильно с любого ракурса, на любом устройстве (вместо экранного AO); в каталоге торшер и бра со своим светом. **Отделка** (Комната → *Отделка и стиль*): стены — покраска, обои, кирпич, панели + цвет, акцентная стена своим цветом, пол — паркет, ламинат, плитка, ковролин; **стиль мебели** модерн / классика (латунные ручки, точёные ножки, фасады с филёнкой) / лофт (чёрная сталь) для всей комнаты или одного предмета — габариты и коллизии не меняются. Свет и отделка сохраняются с комнатой и отменяются.
- **Открывание в 3D:** клик по шкафу, комоду, кухне, холодильнику или двери комнаты (в прогулке — `E`) — дверцы распахиваются, ящики выдвигаются, откидные створки опускаются; 🚪 *Открыть всё* / *Закрыть всё*. В каждом кадре движущаяся часть проверяется по другой мебели, конструктиву и стенам: при касании краснеет, останавливается, а HUD пишет «Дверца упирается в «Кровать» на 64°».
- **Конфигуратор и ориентировочная цена:** у шкафа, комода, тумбы, обувницы и кухни есть «Секций» и «Ящиков» (у шкафа-купе — 2–3 двери); 3D-модель строится по ним (полый корпус, перегородки, полки, штанга, ящики), на плане секции видны пунктиром. У выбранного предмета «≈ 2 310 000 сум» (наведите — разбивка: корпус, фасад, двери, фурнитура…), под списком мебели — «Итого ориентировочно от …»; итог попадает и на плашку снимка, и в заявку. **Цены в `catalog.json` → `pricing` и `materials[].priceRate` ТЕСТОВЫЕ — замените их реальными перед запуском.**
- **Заполнить нишу** (📐): наведите на стену — зелёный «призрак» самого большого шкафа, который там поместится (с плинтусом и зазорами, с проходом перед ним, на 5 см ниже потолка или короба под потолком); клик — выбрать, затем купе или распашной с ценами, «Применить» ставит сконфигурированный шкаф одним шагом отмены.
- **Сравнение вариантов:** ⋯ на вкладке комнаты → «Сравнить с…» — две комнаты проекта рядом (только просмотр) с размерами, числом предметов, ошибками и ценой; по умолчанию — другая версия той же комнаты.
- **Чертёж заявки:** к заявке прикладывается чертёж — план в стандартном масштабе 1:N на белом листе A4 (2400 px): пронумерованные предметы, их габариты и расстояния до стен, окна, двери, конструктив и штамп (проект, комната, размеры, масштаб, цена, № заявки, дата); если открыт 3D — ещё и 3D-снимок. Сервер сохраняет их в `orders/<id>/plan.png` (`3d.jpg`). **🖨 Чертёж / PDF** в форме заявки открывает `print.html`: чертёж и спецификация (№, наименование, габарит, высота от пола, материал и конфигурация, цена) → «Печать / PDF» → «Сохранить как PDF», без библиотек.
- **Заявка** — форма (имя, телефон, комментарий) сохраняется в `order.json` вместе с названием проекта и комнаты; галочка «Отправить все комнаты проекта» отправляет все комнаты (в каждой не должно быть ошибок). Сервер проверяет каждую заявку (`server/validateOrder.js`: белый список полей, диапазоны — размеры 50–3000 см, ≤ 200 предметов, ≤ 50 проёмов / конструктива, маска телефона, PNG-сигнатура и ≤ 2 МБ для чертежа), пропускает 5 заявок с одного IP за 10 минут (иначе «Слишком часто»), молча отбрасывает ботов, заполнивших скрытое поле `website`, и пишет `order.json` через очередь (временный файл + rename) — параллельные заявки не теряются.
- **Страница менеджера** `/admin.html` (см. ниже): таблица заявок — №, дата, имя, телефон (ссылка `tel:`), проект / комната, сумма, статус; фильтр по статусу и поиск; статусы **новая → в работе → замер → готово** (+ отменена) с историей и датами; в карточке заявки — чертёж, 3D-снимок, спецификация, комментарий клиента и заметки менеджера.
- **Вся квартира:** проект — одна квартира, её комнаты стоят на одном плане; дверь в общей перегородке (10 см) ведёт в соседнюю комнату. В шапке площадь, активная комната и **⎘ Варианты** (копии всей квартиры). **✥ Планировка** — перетаскивайте комнаты, они прилипают к соседним через перегородку (`Esc` — выход). Мебель можно перетащить из комнаты в комнату. Старые проекты из одной комнаты переносятся автоматически.
- **Шаблоны квартир:** 📁 Проекты → *Квартира из шаблона* — *хрущёвка* (серии 1-447, 1-464, II-29), *улучшенная планировка* (1-528, II-49, II-57, 121) и *новостройка* (студия, евро-2, 2–4 комнаты), пустые или с мебелью (`apartment-templates.json`, `GET /api/apartments`).
- **Наборы:** 🎲 *Обставить* расставляет готовый набор по назначению комнаты (спальня, детская, зал, кухня, кабинет, прихожая, ванная…) — для одной комнаты или всей квартиры, каждый раз новый вариант; что не поместилось, перечисляется.
- **Уровни отделки:** черновая (бетон, стяжка), предчистовая (white box) и чистовая (как выбрано) — для всей квартиры, переключаются в HUD 3D.
- **Свет:** ☀ день / 🌇 закат / 🌙 ночь с плавным переходом (клавиша `N` — по кругу), 💡 (клавиша `L`) — включить / выключить лампы; комната, где стоит гуляющий, получает солнце и тени.
- **Уведомление о фото-текстурах:** при выборе *Фото* в 3D видна плашка с прогрессом загрузки (≈ 12 МБ, n / всего), затем «применены»; если выбранной отделке нужен набор библиотеки, которого ещё нет на диске, — кнопки **Скачать** / **Не сейчас**; без нажатия ничего не скачивается.
- **Плавно на любом устройстве:** 3D рисуется только когда что-то меняется (в покое 0 кадров), останавливается во скрытой вкладке, вне экрана и под диалогом; уровень качества (экономный / средний / высокий: плотность пикселей, карты теней, сглаживание, анизотропия) выбирается по ядрам процессора, памяти и имени видеокарты и снижается при падении FPS (*Качество 3D*: Авто / Высокое / Экономное); текстуры декодируются вне главного потока; в прогулке рисуются только комната, где вы стоите, и комнаты за открытыми дверями.
- **Библиотека текстур:** 41 набор CC0 (пол, стены, черновая, мебель) с ambientCG, список в `public/textures/library.json`; набор скачивается при первом выборе или все сразу командой `npm run textures` (`-- --kind floor`, `-- --id oakPlanks`).
- **3D-квартира:** все комнаты в одной сцене, одна дверь на перегородку, прогулка из комнаты в комнату (двери открываются сами, проём проверяется на ширину прохода).
- **Витрина новостройки** `/building.html` (🏢 в шапке): демо-дом на 12 этажей (планировки в `buildings/chinor-park.json`, `node scripts/gen-building.mjs`; комнаты, площадь, цена и статус каждой квартиры — в `apartments.json`). Фасад с этажами в цветах статуса (свободна / бронь / продана), фильтры (комнаты, площадь, цена, только свободные), план этажа с подсказкой, карточка квартиры (план с мебелью, комнаты, площадь, цена за м²). Главный экран — **3D-дом** по реальным планировкам квартир (`facade.js` → `bld3d/exterior.js`): тёплый травертин плитами 150 × 75, светлые рамы в глубоких откосах 25 см с мягкой тенью, металлические отливы, балконы со стеклянным ограждением у гостиных, каменные пилястры между квартирами, карниз и парапет, первый этаж из тёмного камня с навесами витрин и козырьком над входом, день / вечер / ночь (плавно), медленный облёт. За каждым окном видна **комната** (один шейдер, без лишней геометрии): стены, пол, потолок, шторы или жалюзи, в стекле отражается небо; вечером и ночью часть комнат светится тёплым светом (на низком уровне качества — простое стекло). Наведение на окно — подсказка квартиры и светлая рамка вокруг всех её окон, клик — карточка, двойной клик — подлёт к этажу; **🎨 Подсветка** (по умолчанию выключена, запоминается) выделяет окна рамкой цвета статуса или комнат и лёгким тоном стекла; фильтры затемняют остальные. Вокруг — **участок** (`bld3d/site.js`): газон, дорожки, улица, парковка с машинами, детская площадка, скамейки, фонари (светят ночью), ~40 деревьев — ствол и ветви с корой, крона из листовых карточек, тень по силуэту листьев (на низком уровне — простые деревья). С фото-наборами газон — фото-трава без заметного повтора, улица — асфальт, дорожки — плитка «волна». **🚶 Прогулка от улицы** — от первого лица по участку (дом, деревья, скамейки, машины не пускают) до дверей подъезда → **лобби** (консьерж, почтовые ящики, закрытые помещения «Аренда») → **лифт** (`E` у дверей — панель этажей 1–12) или **лестница** (± 1 этаж) → **коридор** этажа с номерами на дверях: в свободные и забронированные квартиры можно зайти (квартира меняется за короткое затемнение), проданные заперты; выход через двери лобби — снова на крыльце. Из карточки: **🚶 Пройтись в 3D** — тот же этаж, старт у входной двери квартиры (`/?embed=floor&b=…&apt=…`; этаж или лобби: `/?embed=building&b=…&floor=N`); ничего не сохраняется. **📐 Открыть в планировщике** копирует квартиру в новый проект; **✉ Оставить заявку** отправляет заявку с квартирой; менеджер меняет статус квартиры в карточке заявки (`PATCH /api/buildings/:id/apartments/:no`, токен администратора; статусы хранятся в `data/`).
- **Языки:** EN / UZ / RU. Проекты хранятся в `localStorage`.

### Стек
Node.js + Express (статика + небольшой JSON API), чистый HTML/CSS/JS (ES-модули, без сборки), Canvas 2D, Three.js (npm + importmap).

### Запуск
```bash
npm install
npm start
```
Откройте http://localhost:3000 (Node.js 18+); витрина — http://localhost:3000/building.html. Тесты: `npm test`. Фото-текстуры: `npm run textures` скачивает всю библиотеку (не обязательно, наборы скачиваются и по требованию). Фото фасада новостройки (травертин, чёрный камень, бетон, дерево) и участка (трава, асфальт, плитка, листья, кора) лежат в проекте (`public/textures/sets/`, ≈ 26 МБ). Скачанные наборы комнат — в `public/textures/lib/`, а при подключённом Blob — в Vercel Blob (`npm run textures -- --blob` заполняет его заранее).

**Страница менеджера: вход по паролю.** В заявках персональные данные (имя, телефон), поэтому `/admin.html`, `/bookings.html` и `/calls.html` открываются только после пароля менеджера:
1. `npm run admin-password -- --save` — введите пароль (скрыто, не короче 10 символов); в `.env` попадает только его scrypt-хеш `ADMIN_PASSWORD_HASH`. `.env` не коммитится.
2. Перезапустите `npm start`, откройте http://localhost:3000/admin.html и войдите. Браузер получает HttpOnly-cookie сессии на 12 часов; «Выйти» её завершает, новый пароль завершает все сессии. 5 неверных паролей с одного адреса → пауза 15 минут.
3. Без `ADMIN_PASSWORD_HASH` страницы пишут, что отключены. `ADMIN_TOKEN` (≥ 16 символов) остаётся для скриптов: `Authorization: Bearer <токен>` к тому же API.

### Деплой на Vercel

1. Импортируйте GitHub-репозиторий в Vercel (Express-приложение из `server.js` определяется само; `vercel.json` при сборке копирует three.js в `public/vendor/three/` и ставит функции во Франкфурт, `fra1`).
2. Storage → **Neon** (регион Франкфурт, `eu-central-1`) — даёт `DATABASE_URL`: заявки, их картинки и статусы квартир хранятся в Postgres, таблицы создаются при первом запросе.
3. Storage → **Blob** (public) — даёт `BLOB_STORE_ID` (у старых хранилищ — `BLOB_READ_WRITE_TOKEN`): наборы текстур комнат, скачанные по требованию, хранятся там и отдаются по тому же адресу `/textures/lib/` (их кэширует CDN). Наборы фасада и участка — в проекте.
4. Пароль менеджера: `npm run admin-password -- --vercel` задаёт `ADMIN_PASSWORD_HASH` (production). По желанию: `ADMIN_TOKEN` (длинная случайная строка) для скриптов.
5. Сделайте Redeploy. Локально `vercel env pull` записывает переменные в `.env.local` (не в git), тогда `npm start` работает с той же базой; `npm run textures -- --blob` заранее заполняет Blob.

Ограничения: заявка — до ≈ 4 МБ (картинки уменьшаются в браузере); свои фото-текстуры остаются в браузере посетителя (IndexedDB). Без `DATABASE_URL` всё хранится в файлах, как при локальной работе, — на Vercel эти файлы не сохраняются.

### Управление
| Где | Действие | Как |
|---|---|---|
| 2D | Перемещение | перетаскивание мышью / пальцем |
| 2D | Поворот / удаление / сдвиг | `R` / `Del` / стрелки (`Shift` ×10) |
| 2D | Окно / дверь | перетаскивание вдоль стены; `Del` / стрелки у выбранного; 🔒 — замок |
| 2D | Отмена / повтор | `Ctrl+Z` / `Ctrl+Y` (`Ctrl+Shift+Z`) |
| 2D | Дублировать / выделить всё | `Ctrl+D` / `Ctrl+A` |
| 2D | Выделение нескольких | `Shift`/`Ctrl`+клик, `Shift`+протяжка по пустому полу |
| 2D | Масштаб / сдвиг | колесо, щипок / протяжка по пустому полу, `Пробел`+протяжка, средняя кнопка |
| 2D | Линейка | `M` или 📏; `Shift` — ровная линия; `Esc` — выход |
| 2D | Заполнить нишу | 📐, навести на стену, клик; `Esc` — выход |
| 3D Обзор | Вращение / масштаб / сдвиг | левая кнопка / колесо / правая кнопка |
| 3D Прогулка | Ходьба | `W A S D` / стрелки, `Shift` — быстрее |
| 3D Прогулка | Взгляд | мышь (после клика) или, если захват курсора недоступен, зажать кнопку мыши и вести |
| 3D Прогулка | Выход | `Esc` |
| 3D | Открыть / закрыть дверцу, ящик | клик, в прогулке `E`; 🚪 — всё |
| Мобильные | Ходьба / взгляд | джойстик / свайп |
| Квартира | Планировка (двигать комнаты) | ✥, `Esc` — выход |
| 3D | Включить / выключить лампы | `L` или 💡 |
| 3D | День → закат → ночь | `N` |
| Этаж в 3D | Дверь соседа / лифт / лестница | `E` у двери (продана — заперта); панель лифта: кнопки этажей, `Esc` — закрыть |
| Витрина 3D | Прогулка от улицы | кнопка 🚶, `W A S D` / стрелки, мышь (клик — захват), тач: свайп + ▲ ▼; `Esc` — назад к облёту |
| 3D | День / закат / ночь, уровень отделки | кнопки HUD ☀ 🌇 🌙, Черновая / Предчистовая / Чистовая |

### Структура проекта
```
server.js            Express: статика, каталог, шаблоны, квартиры, дома, заявки (+ файлы чертежей), API менеджера, текстуры (список / загрузка / сброс / ZIP / библиотека)
server/              validateOrder (проверка заявки), orderStore (очередь записи, лимит частоты), buildings (статусы квартир), textureFetch, zip
orders/<id>/         чертежи заявок plan.png / 3d.jpg (не в git)
.env.example         ADMIN_PASSWORD_HASH / ADMIN_TOKEN для страниц менеджера (скопировать в .env)
catalog.json         каталог мебели (типы, размеры по умолчанию, названия на 3 языках)
templates.json       шаблоны комнат (советский дом / новостройка) и наборы квартир
apartment-templates.json  шаблоны квартир (хрущёвка / улучшенная / новостройка)
apartments.json      квартиры новостройки: номер, этаж, комнаты, площадь, цена (сум), статус free / booked / sold
buildings/           демо-дом для витрины; data/ — статусы квартир (не в git)
scripts/             fetch-textures (npm run textures), gen-apartments, gen-building
order.json           сохранённые заявки
public/print.html    чертёж + спецификация для печати / PDF; public/admin.html — страница менеджера
public/index.html    разметка; building.html — витрина новостройки
public/css/          стили
public/js/           2D: state, geometry, openings, validate, renderer, interaction, autoplace, ui, i18n, storage, order,
                     history (отмена), align, ruler, projects (комнаты, вкладки), projectsDialog, obstacles, catalog, zones, passages, templates,
                     snapshot, materials, matPanel, style, stylePanel, config, pricing, pricePanel, nicheTool, compare, drawing, admin,
                     apartment, kits, furnish, furnishUi, aptTemplates, lighting, walkMap, building, buildingPage, floor3d, facade
public/js/3d/        3D: scene3d, room3d, models3d, models3dMore, textures3d, lights3d, controls3d, touch3d, obstacles3d, anim3d, perf
public/js/bld3d/     showcase 3D: exterior (building), site (grounds), streetWalk (first person outside)
public/textures/     фото-текстуры CC0 (ambientCG); lib/ — скачанные наборы библиотеки (не в git)
test/                модульные тесты (node:test): npm test
```

### Правила
- Все размеры в сантиметрах; шаг привязки 3–5 см.
- Мебель на плане — прямоугольник; коллизии считаются по габариту (AABB).
- Мебель не должна выходить за границы комнаты с учётом плинтуса и пересекаться с другими предметами.

### Лицензии
Фото-текстуры: [ambientCG](https://ambientcg.com) — CC0. Three.js — MIT.
