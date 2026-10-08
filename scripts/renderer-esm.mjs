/* Imported first by a check that loads the renderer's lib code under plain
   node. package.json pins "type": "commonjs", so the renderer's files are read
   as the ES modules vite reads them as. Load them with a dynamic import after
   this one: a static import is loaded before this hook is registered. */
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    return url.includes('/src/renderer/') ? { ...loaded, format: 'module' } : loaded;
  },
});
