# Neon concurrency — 2026-10-27

Base: `ep-wild-resonance-banuwl4t.c-8.eu-central-1.aws.neon.tech` (a throwaway branch, emptied before every round). Rounds: 5. Verdict: **PASS** — 0 double bookings, 0 double payments, every job exactly once (DoD-3, DoD-4).

| Step | Rounds | Attempts | Right outcomes | Rounds with a failure | Mean time, ms |
|---|---|---|---|---|---|
| 20 holds on one apartment (core, 20 connections) | 5 | 100 | 5 | 0 | 6974 |
| 20 × POST /api/bookings/hold (HTTP) | 5 | 100 | 5 | 0 | 8470 |
| 10 payments of one booking reported paid at once | 5 | 50 | 5 | 0 | 17426 |
| 10 deliveries of one Stripe event | 5 | 50 | 5 | 0 | 4030 |
| 10 Click Complete with one click_trans_id | 5 | 50 | 5 | 0 | 6427 |
| 50 due jobs, 5 callers of POST /api/jobs/run | 5 | 250 | 250 | 0 | 31447 |
