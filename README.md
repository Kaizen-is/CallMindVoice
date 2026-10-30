# callmind

Production: https://callmind.brb-tech.uz

Kubernetes namespace: `callmind`. Protected infrastructure deployment is managed from Q.Raximov/kubernetes-infra. Production data and credentials are kept outside Git in persistent volumes and Kubernetes Secrets. `.env.example` lists required variable names.

The migration preserves the original production image. Source changes require a new tested image build and an update to the protected deployment manifest.
