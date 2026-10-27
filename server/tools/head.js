// The head's tools (08 §3.2). funnel and ai_activity come with core/analytics of the dashboard (D4-08).
import sales_summary from './sales_summary.js';
import list_bookings from './list_bookings.js';
import list_payments from './list_payments.js';
import list_viewings from './list_viewings.js';
import extend_booking from './extend_booking.js';
import cancel_booking from './cancel_booking.js';

export const HEAD_TOOLS = [sales_summary, list_bookings, list_payments, list_viewings, extend_booking, cancel_booking];
