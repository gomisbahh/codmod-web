#!/usr/bin/env bash

# =========================================================================
# Google Cloud Run Deployment Script for Google Codmod Web Wrapper
# =========================================================================

set -euo pipefail

# =========================================================================
# Configuration - CUSTOMERS / USERS: CHANGE THESE VALUES FOR YOUR GCP ENVIRONMENT
# =========================================================================
# PROJECT_ID: Your target Google Cloud project ID (replace "coba-sdlc" with your project ID)
PROJECT_ID="coba-sdlc"
# REGION: The GCP region for Cloud Run, Artifact Registry, and GCS bucket
REGION="us-central1"
# SERVICE_NAME: Name of the Cloud Run service
SERVICE_NAME="codmod-gui"
# REPO_NAME: Name of the Docker Artifact Registry repository
REPO_NAME="codmod-repo"
# GCS_BUCKET_NAME: Target GCS bucket for assessment reports (must be globally unique across GCP)
GCS_BUCKET_NAME="codmod-output"

# Application-Level Passcode Authentication Config
# Set to "true" to enable the built-in login screen when hosting on the direct run.app URL.
# Set to "false" if you are using IAP + Load Balancer edge authentication.
APP_AUTH_ENABLED="true"
# APP_PASSWORD: The shared passcode required to unlock the web dashboard
APP_PASSWORD="MySecurePasscode123"  # Change this to your desired dashboard passcode


# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Starting Google Codmod Web Wrapper Deployment ===${NC}"

# Check if project ID was changed
if [ "$PROJECT_ID" == "YOUR_GCP_PROJECT_ID" ] || [ "$GCS_BUCKET_NAME" == "YOUR_TARGET_GCS_BUCKET_NAME" ]; then
  echo -e "${RED}Error: Please open deploy.sh and configure your PROJECT_ID and GCS_BUCKET_NAME.${NC}"
  exit 1
fi

# 1. Set gcloud project
echo -e "\n${YELLOW}[1/6] Setting gcloud active project...${NC}"
gcloud config set project "$PROJECT_ID"

# 2. Enable Google Cloud APIs
echo -e "\n${YELLOW}[2/6] Enabling required Google Cloud APIs...${NC}"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  aiplatform.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com

# 3. Create Google Cloud Storage Bucket (if it doesn't exist)
# Creating it as a regional bucket with STANDARD storage class and uniform bucket-level access
# to optimize it for high-throughput resumable uploads.
echo -e "\n${YELLOW}[3/6] Verifying GCS bucket: gs://${GCS_BUCKET_NAME}...${NC}"
if gcloud storage buckets describe "gs://${GCS_BUCKET_NAME}" &>/dev/null; then
  echo -e "${GREEN}Bucket gs://${GCS_BUCKET_NAME} already exists.${NC}"
else
  echo -e "${BLUE}Creating regional bucket gs://${GCS_BUCKET_NAME} in region ${REGION}...${NC}"
  gcloud storage buckets create "gs://${GCS_BUCKET_NAME}" \
    --location="$REGION" \
    --default-storage-class=STANDARD \
    --uniform-bucket-level-access
  echo -e "${GREEN}Bucket created successfully.${NC}"
fi

# 3b. Verify and Create Artifact Registry Repository (if it doesn't exist)
echo -e "\n${YELLOW}[3b/6] Verifying Artifact Registry Repository: ${REPO_NAME}...${NC}"
if gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" &>/dev/null; then
  echo -e "${GREEN}Artifact Registry Repository ${REPO_NAME} already exists.${NC}"
else
  echo -e "${BLUE}Creating Artifact Registry Repository ${REPO_NAME} in region ${REGION}...${NC}"
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Docker repository for Codmod GUI"
  echo -e "${GREEN}Repository created successfully.${NC}"
fi

# 4. IAM ROLE ASSIGNMENT (Principle of Least Privilege)
# We perform this step BEFORE deployment so the service has the correct permissions immediately upon startup.
echo -e "\n${YELLOW}[4/6] Configuring IAM Permissions for Security...${NC}"

# Get the default Cloud Run service account
# Cloud Run services by default run as the Default Compute Service Account
# (<project-number>-compute@developer.gserviceaccount.com) unless a custom SA is provided.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUN_SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo -e "Assigning roles to Cloud Run Service Account: ${BLUE}${RUN_SERVICE_ACCOUNT}${NC}"

# A. Grant Vertex AI User (roles/aiplatform.user) on the project so codmod can access Gemini models
echo -e "Granting ${YELLOW}Vertex AI User (roles/aiplatform.user)${NC} on project..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUN_SERVICE_ACCOUNT}" \
  --role="roles/aiplatform.user"

# B. Grant Storage Object Admin (roles/storage.objectAdmin) on the specific GCS bucket
echo -e "Granting ${YELLOW}Storage Object Admin (roles/storage.objectAdmin)${NC} on bucket gs://${GCS_BUCKET_NAME}..."
gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET_NAME}" \
  --member="serviceAccount:${RUN_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin"

# 5. Read/Increment Version and Build & Push Container using Google Cloud Build
echo -e "\n${YELLOW}[5/6] Bumping version and building container via Google Cloud Build...${NC}"

VERSION_FILE="version.txt"
if [ ! -f "$VERSION_FILE" ]; then
  echo "1.0.0" > "$VERSION_FILE"
fi

CURRENT_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
# Parse major.minor.patch
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
if [ -z "${MAJOR:-}" ] || [ -z "${MINOR:-}" ] || [ -z "${PATCH:-}" ]; then
  MAJOR=1
  MINOR=0
  PATCH=0
fi

# Increment patch version
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"

# Save updated version back to file
echo "$NEW_VERSION" > "$VERSION_FILE"

echo -e "Upgraded build version: ${YELLOW}${CURRENT_VERSION}${NC} -> ${GREEN}${NEW_VERSION}${NC}"

IMAGE_TAG_VERSION="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}:${NEW_VERSION}"
IMAGE_TAG_LATEST="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}:latest"

echo -e "Building Docker image with tag: ${BLUE}${IMAGE_TAG_VERSION}${NC}"
gcloud builds submit --tag "$IMAGE_TAG_VERSION" .

# Also tag the newly built image as latest in Artifact Registry
echo -e "Tagging image as ${BLUE}:latest${NC} in Artifact Registry..."
gcloud artifacts docker tags add "${IMAGE_TAG_VERSION}" "${IMAGE_TAG_LATEST}" --quiet || true

# 6. Deploy to Google Cloud Run
echo -e "\n${YELLOW}[6/6] Deploying service to Google Cloud Run (version ${NEW_VERSION})...${NC}"
# We deploy with:
# - --allow-unauthenticated (so users can access the GUI web page)
# - --port 8080 (Express port)
# - --cpu 2 --memory 4Gi (Recommended: Cloning repositories and running analysis are resource-heavy)
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE_TAG_VERSION" \
  --region "$REGION" \
  --port 8080 \
  --cpu 2 \
  --memory 4Gi \
  --max-instances 1 \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --set-env-vars="HOST=0.0.0.0,NODE_ENV=production,APP_AUTH_ENABLED=${APP_AUTH_ENABLED},APP_PASSWORD=${APP_PASSWORD},GCS_BUCKET_NAME=${GCS_BUCKET_NAME}"

# Get the Cloud Run service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')

echo -e "\n${GREEN}=== DEPLOYMENT SUCCESSFUL ===${NC}"
echo -e "Deployed Version:              ${GREEN}v${NEW_VERSION}${NC}"
echo -e "Your application is hosted at: ${BLUE}${SERVICE_URL}${NC}"
echo -e "Ensure that users trigger assessments using target bucket: ${YELLOW}${GCS_BUCKET_NAME}${NC}"
echo -e "================================================="
