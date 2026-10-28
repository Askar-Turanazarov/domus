# Neon concurrency — 2026-10-28

Base: `ep-wild-resonance-banuwl4t.c-8.eu-central-1.aws.neon.tech` (a throwaway branch, emptied before every round). Rounds: 5. Verdict: **PASS** — 0 double bookings, 0 double payments, every job exactly once (DoD-3, DoD-4).

| Step | Rounds | Attempts | Right outcomes | Rounds with a failure | Mean time, ms |
|---|---|---|---|---|---|
| 20 holds on one apartment (core, 20 connections) | 5 | 100 | 5 | 0 | 7112 |
| 20 × POST /api/bookings/hold (HTTP) | 5 | 100 | 5 | 0 | 8489 |
| 10 payments of one booking reported paid at once | 5 | 50 | 5 | 0 | 18389 |
| 10 deliveries of one Stripe event | 5 | 50 | 5 | 0 | 4474 |
| 10 Click Complete with one click_trans_id | 5 | 50 | 5 | 0 | 6874 |
| 50 due jobs, 5 callers of POST /api/jobs/run | 5 | 250 | 250 | 0 | 33223 |
