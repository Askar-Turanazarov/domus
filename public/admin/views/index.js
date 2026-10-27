// Sections of the admin (12 §1): the menu and the router read this list. A section is { id, title (i18n key), roles, mount }.
// mount(root, { staff, params, go }) draws into `root` and returns a stop() that ends its polling.
import * as units from './units.js';

export const sections = [
  { id: 'units', title: 'nav.units', roles: ['manager', 'head'], mount: units.mount }
];
export const defaultSection = 'units';
