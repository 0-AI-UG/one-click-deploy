# hello-app fixture

Minimal Dockerfile used by the engine integration test suite
(`src/integration/engine-ops.test.ts`).

Push these three files to a public GitHub repo, then set
`OCD_TEST_GIT_REPO` to the clone URL (e.g.
`https://github.com/you/ocd-test-fixture.git`).

The image serves `hello from ocd-itest` on port 8080.
