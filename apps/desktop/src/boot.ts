// Packaged app entry. Enables the compile cache before the main bundle loads,
// so the cache also covers main.cjs itself.
require("./compileCache.cjs");
// Installed builds launch the pill without needing the development launcher.
process.env.T3CODE_SATELLITE_PILL ??= "1";
require("./main.cjs");
