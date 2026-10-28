// The head's tools (08 §3.2): the reading ones (also the analyst's, 07 §14) and the two changing ones (MCP only, with a confirmation).
import sales_summary from './sales_summary.js';
import funnel from './funnel.js';
import list_bookings from './list_bookings.js';
import list_payments from './list_payments.js';
import list_viewings from './list_viewings.js';
import ai_activity from './ai_activity.js';
import extend_booking from './extend_booking.js';
import cancel_booking from './cancel_booking.js';

export const HEAD_TOOLS = [sales_summary, funnel, list_bookings, list_payments, list_viewings, ai_activity, extend_booking, cancel_booking];
