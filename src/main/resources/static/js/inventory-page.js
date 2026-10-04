import {initInventoryPage} from './plugins/material/material-manager.js';
await initInventoryPage(location.hash === '#remnants' ? 'remnants' : 'rolls');
