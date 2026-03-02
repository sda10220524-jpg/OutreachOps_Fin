# OutreachOps MVP (grid-only, no individual tracking)

Static frontend demo for GitHub Pages.

## Run locally

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In **Settings → Pages**, choose **Deploy from branch**.
3. Select branch and folder `/ (root)`.
4. Save. GitHub Pages will serve `index.html`.

## Demo script (F1/F2/F3)

1. F1: Go to **Request**, pick category + cell, submit.
   - Cell label updates immediately, priority row flashes/moves, Backlog increases immediately.
2. F2: Dashboard → **Resources**, change capacity/state.
   - Capacity effect applies instantly and priority list visibly reorders.
3. F3: Dashboard → **Outreach Log Entry**, keep selected grid, choose `resolved`, save.
   - Backlog decreases immediately and Avg response time updates immediately.

Use **Reset demo data** to return to realistic starter values.

## Data minimization

Persisted only:

- Signal: `created_at`, `source_type`, `category`, `grid_id`, `status`, `weight`
- ResourceStatus: `resource_id`, `resource_type`, `availability_state`, `updated_at`, `capacity_score`
- OutreachLog: `created_at`, `org_id`, `grid_id`, `action`, `outcome`

No lat/lng/address/PII are stored.
