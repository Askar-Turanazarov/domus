// Sections of the admin (12 §1): the menu and the router read this list. A section is { id, title (i18n key), roles, mount }.
// mount(root, { staff, params, go }) draws into `root` and returns a stop() that ends its polling.
import * as units from './units.js';
import * as bookings from './bookings.js';
import * as payments from './payments.js';
import * as clients from './clients.js';
import * as outbox from './outbox.js';
import * as ai from './ai.js';

export const sections = [
  { id: 'units', title: 'nav.units', roles: ['manager', 'head'], mount: units.mount },
  { id: 'bookings', title: 'nav.bookings', roles: ['manager', 'head'], mount: bookings.mount },
  { id: 'payments', title: 'nav.payments', roles: ['manager', 'head'], mount: payments.mount },
  { id: 'clients', title: 'nav.clients', roles: ['manager', 'head'], mount: clients.mount },
  { id: 'ai', title: 'nav.ai', roles: ['manager', 'head'], mount: ai.mount },
  { id: 'outbox', title: 'nav.outbox', roles: ['head'], mount: outbox.mount }
];
export const defaultSection = 'units';
