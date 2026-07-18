---
name: Test Driven Development
description: Use a failing behavioral test to pin the requirement, implement the smallest repair and keep the regression covered.
license: MIT
origin: adapted-from-obra-superpowers
---

# Test Driven Development

## Loop

1. Express one behavior as a small test with a meaningful failure.
2. Run it and confirm it fails for the intended reason.
3. Implement the minimum production change that can pass.
4. Run the focused test and then the relevant suite.
5. Refactor only while the suite stays green.

Prefer boundary and integration tests for agent behavior: provider failover, approval pauses, memory authority and durable workflow recovery.

