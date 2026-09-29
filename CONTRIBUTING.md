# Contributing

Thanks for your interest in HomeCast. Bug reports, site compatibility reports and pull requests are all welcome.

## Reporting issues

When a site doesn't work, please include the URL (or the kind of site, if it's private) and the receiver you cast to.
Also include the server log lines from pressing Analyze to the failure. For device problems, include the receiver's
model and, if it's relevant, the startup log.

## Development setup

You need Node.js 26 or newer.

```bash
npm install
npm run dev
```

`npm run dev` starts the server in development mode. It adds a mock Chromecast to the device list, which fetches the
stream the way a real receiver does. You can then test casting, the dashboard and stall recovery without a TV.

The frontend in `public/` is plain ES modules with no build step. The server is in `server.js`, `routes/` and `lib/`.

## Checks

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript, over JSDoc types
npm test            # node:test unit and HTTP tests
npm run check       # all three
```

CI runs `lint`, `typecheck` and the tests on every branch and pull request. Please run `npm run check` before opening
a pull request, and add tests for behaviour you change.

## Releases

Maintainers release with:

```bash
npm run release:patch   # or release:minor / release:major
```

The script runs the checks, bumps the version, commits, tags `vX.Y.Z` and, once confirmed, pushes. The tag triggers
the Docker workflow, which builds the `full` and `lite` images for amd64 and arm64. It publishes them to GHCR with
attestations as `latest`/`lite` and as the version at each precision (`1.2.3`, `1.2`, `1`).
