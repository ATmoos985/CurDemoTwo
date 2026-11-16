import {showcaseTarget} from './showcase-redirect.js';
const target = showcaseTarget(location.href);
if (target) location.replace(target);
