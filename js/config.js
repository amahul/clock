// Public Supabase settings, loaded by the browser.
//
// The anon (or "publishable") key is meant to be public: it's visible to
// every visitor anyway. What it can do is limited by Row Level Security and
// function grants in supabase/setup.sql: read the clock, read the server time.
//
// NEVER put the service_role (or "secret", sb_secret_...) key in this file or
// anywhere else in this project. It bypasses Row Level Security, and this
// site is published as-is on GitHub Pages. tests/config.test.js checks this.

// supabase-js ES module build, pinned to an exact version.
export const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";

export const SUPABASE_URL ="https://cwwdaoryzstorctiqaht.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3d2Rhb3J5enN0b3JjdGlxYWh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzMzcyOTYsImV4cCI6MjEwNTkxMzI5Nn0.qESHrB26BHuvllUWl8lVnRV8ZgQJuF66AanggL2GVmk";
