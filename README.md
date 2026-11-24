# callmind

Production: https://callmind.brb-tech.uz

Kubernetes namespace: `callmind`. Protected infrastructure deployment is managed from Q.Raximov/kubernetes-infra. Production data and credentials are kept outside Git in persistent volumes and Kubernetes Secrets. `.env.example` lists required variable names.

The migration preserves the original production image. Source changes require a new tested image build and an update to the protected deployment manifest.

## CI pipeline

Every push runs `.gitlab-ci.yml`:

1. **test** — `npm test` (TypeScript typecheck), `npm audit --audit-level=high`, and for the Python backend `ruff check`, `ruff format --check` and `pytest` in `backend/`
2. **build** — `npm run build`
3. **staging** — `scripts/ci-isolated-smoke.sh` builds the Docker image and checks HTTP readiness and Zipformer model files in an isolated container (no network)

All server code runs in the Python backend (`backend/`, FastAPI, `callmind-api.service`); the Next.js app is the web UI and needs it running (see `docs/handoff.md`). The Docker image builds only the web UI.

The pipeline does not deploy to production.
