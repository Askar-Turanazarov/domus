// Sections of the admin (12 §1): the menu and the router read this list. A section is { id, title (i18n key), roles, mount }.
// mount(root, { staff, params, go }) draws into `root` and returns a stop() that ends its polling.
import * as units from './units.js';
import * as bookings from './bookings.js';
import * as payments from './payments.js';
import * as clients from './clients.js';
import * as inbox from './inbox.js';
import * as orders from './orders.js';
import * as outbox from './outbox.js';
import * as ai from './ai.js';
import * as analyst from './analyst.js';
import * as system from './system.js';

export const sections = [
  { id: 'units', title: 'nav.units', roles: ['manager', 'head'], mount: units.mount },
  { id: 'bookings', title: 'nav.bookings', roles: ['manager', 'head'], mount: bookings.mount },
  { id: 'payments', title: 'nav.payments', roles: ['manager', 'head'], mount: payments.mount },
  { id: 'clients', title: 'nav.clients', roles: ['manager', 'head'], mount: clients.mount },
  { id: 'inbox', title: 'nav.inbox', roles: ['manager', 'head'], mount: inbox.mount, badge: 'inbox' },
  { id: 'orders', title: 'nav.orders', roles: ['manager', 'head'], mount: orders.mount },
  { id: 'ai', title: 'nav.ai', roles: ['manager', 'head'], mount: ai.mount },
  { id: 'analyst', title: 'nav.analyst', roles: ['head'], mount: analyst.mount },
  { id: 'outbox', title: 'nav.outbox', roles: ['head'], mount: outbox.mount },
  { id: 'system', title: 'nav.system', roles: ['head'], mount: system.mount }
];
export const defaultSection = 'units';
