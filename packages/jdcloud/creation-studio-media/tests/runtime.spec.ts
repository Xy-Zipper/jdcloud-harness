/** Run the migrated JavaScript execution regressions against source modules. */
await import(new URL('./runtime-tests.mjs', import.meta.url).href)
