const { executeBash } = require("./src/tools/bash.js");

let r = executeBash("Get-Date");
console.log("test 1 - Get-Date: exit:", r.exitCode, "ok:", r.stdout.trim().length > 0);

r = executeBash('New-Item -Path "e2e-test.md" -ItemType File -Force');
console.log("test 2 - New-Item: exit:", r.exitCode, "stdout:", r.stdout.trim().slice(0, 60));

r = executeBash('Get-Content "e2e-test.md"');
console.log("test 3 - Get-Content: exit:", r.exitCode, "stdout:", r.stdout.trim());
