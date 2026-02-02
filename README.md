# Embers

An observability test generator that creates traces, logs, and metrics for testing your Grafana observability stack (Loki, Mimir, Tempo). Features an interactive flame visualization where more flames = more data generation.

## Features

- **Interactive Flame Visualization**: Dark-themed UI with animated flames
- **OpenTelemetry Integration**: Pushes traces, logs, and metrics to OTEL collector endpoint
- **Prometheus Metrics**: Exposes `/metrics` endpoint for scraping
- **Configurable Data Volume**: More flames generate more observability data
- **Kubernetes Ready**: Includes deployment manifests with health checks

## Quick Start

### Run with Docker

```bash
# Build the image
docker build -t embers:latest .

# Run the container
docker run -p 3000:3000 \
  -e OTEL_ENDPOINT=http://alloy.sparks.majerus.dev \
  embers:latest
```

Access the application at `http://localhost:3000`

### Run Locally (Development)

```bash
# Install dependencies
npm install

# Set environment variables
export OTEL_ENDPOINT=http://alloy.sparks.majerus.dev

# Start the server
npm start
```

## Kubernetes Deployment

### Prerequisites

- Kubernetes cluster with kubectl configured
- Ingress controller (e.g., nginx-ingress)
- Optional: cert-manager for TLS certificates

### Deploy to Kubernetes

1. **Update the Ingress hostname** in `k8s/ingress.yaml`:
   ```yaml
   spec:
     rules:
     - host: your-domain.com  # Change this
   ```

2. **Update the OTEL endpoint** in `k8s/deployment.yaml` if needed:
   ```yaml
   env:
   - name: OTEL_ENDPOINT
     value: "http://your-alloy-endpoint"
   ```

3. **Build and push the Docker image**:

   For local clusters (minikube/kind):
   ```bash
   docker build -t embers:latest .

   # For minikube
   minikube image load embers:latest

   # For kind
   kind load docker-image embers:latest
   ```

   For remote clusters (using Docker Hub):
   ```bash
   # Build the image
   docker build -t embers:latest .

   # Tag with your Docker Hub username
   docker tag embers:latest YOUR_DOCKERHUB_USERNAME/embers:latest

   # Login and push
   docker login
   docker push YOUR_DOCKERHUB_USERNAME/embers:latest
   ```

   Then update the image in `k8s/deployment.yaml`:
   ```yaml
   image: YOUR_DOCKERHUB_USERNAME/embers:latest
   ```

4. **Configure private registry authentication** (if using private Docker Hub):

   Create a Personal Access Token at https://hub.docker.com/settings/security, then:
   ```bash
   kubectl create secret docker-registry dockerhub-secret \
     --docker-server=https://index.docker.io/v1/ \
     --docker-username=YOUR_DOCKERHUB_USERNAME \
     --docker-password=YOUR_ACCESS_TOKEN \
     --docker-email=YOUR_EMAIL \
     -n embers
   ```

   The deployment is already configured to use this secret via `imagePullSecrets`.

5. **Apply the manifests**:
   ```bash
   kubectl apply -k k8s/
   ```

   Or apply in order manually:
   ```bash
   kubectl apply -f k8s/namespace.yaml
   kubectl apply -f k8s/
   ```

6. **Verify deployment**:
   ```bash
   kubectl get pods -n embers
   kubectl get svc -n embers
   kubectl get ingress -n embers
   ```

7. **Access the application**:
   - Via Ingress: `https://embers.sparks.majerus.dev`
   - Via Port Forward: `kubectl port-forward -n embers svc/embers 3000:80`

## Observability Data Generated

### Traces
- Flame creation and initialization
- Button click interactions
- API requests and responses
- Automatic instrumentation of Express routes

### Logs (Structured JSON)
- Flame count updates
- Render cycle events
- Button click events
- Random simulation logs (physics, heat, combustion, etc.)
- **Volume**: Proportional to flame count

### Metrics (Prometheus)
- `embers_flame_count` - Current number of flames
- `embers_render_duration_ms` - Render performance histogram
- `embers_button_clicks_total` - Button click counter
- `embers_uptime_seconds` - Application uptime
- `embers_temperature_celsius` - Simulated flame temperature
- `embers_sparks_emitted_total` - Random spark counter
- Plus Node.js default metrics (memory, CPU, etc.)

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_ENDPOINT` | OpenTelemetry collector endpoint | `http://localhost:4318` |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment (production/development) | - |

### Kubernetes Configuration

Edit `k8s/deployment.yaml` to customize:
- Resource limits/requests
- Number of replicas
- OTEL endpoint
- Health check settings
- Container image (default: `majerus1223/embers:latest`)

**Image Pull Secrets:**
The deployment uses `imagePullSecrets` to authenticate with private Docker registries. If using a private Docker Hub repository, create the secret as shown in the deployment instructions above.

## Endpoints

- `/` - Main application UI
- `/health` - Health check endpoint
- `/metrics` - Prometheus metrics endpoint

## Architecture

- **Backend**: Node.js + Express
- **Frontend**: Vanilla JavaScript + HTML5 Canvas
- **Observability**: OpenTelemetry SDK + Prometheus client
- **Container**: Multi-stage Docker build with Alpine Linux

## Development

### Project Structure

```
embers/
├── server.js           # Express server with OTEL instrumentation
├── public/
│   ├── index.html     # Frontend UI
│   └── flames.js      # Canvas animation and API calls
├── k8s/
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   └── ingress.yaml
├── Dockerfile
├── package.json
└── README.md
```

### Flame Animation

The flame animation uses HTML5 Canvas with particle systems. Each flame consists of 20 particles that:
- Rise upward with gravity
- Fade over time
- Use gradient colors (red to yellow)
- Continuously regenerate

### Observability Pipeline

```
Embers App
  ├─> Push to OTEL Endpoint (traces, logs, metrics)
  └─> Expose /metrics for Prometheus scraping
        ↓
    Grafana Alloy
        ↓
    ├─> Tempo (traces)
    ├─> Loki (logs)
    └─> Mimir (metrics)
```

## Troubleshooting

### Container won't start
```bash
# Check logs
docker logs <container-id>

# Verify OTEL endpoint is reachable
docker exec <container-id> wget -O- http://alloy.sparks.majerus.dev
```

### Kubernetes pod not ready
```bash
# Check pod logs
kubectl logs -f deployment/embers -n embers

# Check events
kubectl describe pod <pod-name> -n embers

# Verify service endpoints
kubectl get endpoints embers -n embers
```

### No data in Grafana
1. Verify OTEL endpoint is correct
2. Check if Alloy is receiving data
3. Verify network connectivity from pod to Alloy
4. Check Alloy configuration for correct receivers

## License

MIT
