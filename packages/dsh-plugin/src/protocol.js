import { createPluginDeclaration } from '../../camp-protocol/src/index.js';

// The supervisor reads this from the actual selected bundle before claiming.
// It is static: no run credentials, model initialization or network requests.
export const pluginProtocol = createPluginDeclaration();
