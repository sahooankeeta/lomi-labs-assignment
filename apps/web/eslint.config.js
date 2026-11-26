import base from '@lomi/config/eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [...base, reactHooks.configs.flat.recommended];
