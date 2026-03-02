# OutreachOps MVP (grid-only, no individual tracking)

Static frontend demo for GitHub Pages.

## Run locally

Because this app is plain static files, run any static file server from repo root:

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In **Settings → Pages**, choose **Deploy from branch**.
3. Select branch `main` (or current) and folder `/ (root)`.
4. Save. GitHub Pages will serve `index.html` directly.

No build pipeline is required.

## MVP demo script (F1/F2/F3)

1. **F1 submit request immediate update**
   - Open **Request** screen.
   - Choose category + click one grid cell.
   - Submit.
   - App returns to Dashboard and that cell Demand value, priority list, and Backlog KPI update immediately.
2. **F2 resource capacity/state reorder**
   - On Dashboard → Resources tab, change availability/capacity.
   - Priority list order re-sorts immediately using `P = Demand / (Capacity + 0.1)`.
3. **F3 outreach log immediate KPI update**
   - On Dashboard click **Outreach Log Entry**.
   - Choose grid + outcome, save.
   - Backlog and Avg response time KPIs update immediately.

## Data minimization

Only these objects are persisted in localStorage:

- Signal: `created_at`, `source_type`, `category`, `grid_id`, `status`, `weight`
- ResourceStatus: `resource_id`, `resource_type`, `availability_state`, `updated_at`, `capacity_score`
- OutreachLog: `created_at`, `org_id`, `grid_id`, `action`, `outcome`

No lat/lng/address/PII are stored.
