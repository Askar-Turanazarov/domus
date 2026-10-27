// The client tools (08 §3.1) in the order the models see them.
import search_apartments from './search_apartments.js';
import get_apartment from './get_apartment.js';
import calc_mortgage from './calc_mortgage.js';
import calc_installment from './calc_installment.js';
import compare_finance from './compare_finance.js';
import my_bookings from './my_bookings.js';
import book_viewing from './book_viewing.js';
import create_booking from './create_booking.js';
import request_extension from './request_extension.js';
import call_manager from './call_manager.js';
import search_kb from './search_kb.js';

export const CLIENT_TOOLS = [search_apartments, get_apartment, calc_mortgage, calc_installment, compare_finance, my_bookings,
  book_viewing, create_booking, request_extension, call_manager, search_kb];
