#!/usr/bin/env bash

# =========================================================================
# Google Cloud IAP & Load Balancer Setup for Private Cloud Run
# =========================================================================
# This script sets up a Global HTTPS Load Balancer with a Serverless NEG
# and enables Identity-Aware Proxy (IAP) to provide a secure web login
# without changing your project's Domain Restricted Sharing policy.

set -euo pipefail

# =========================================================================
# CONFIGURATION - CUSTOMERS / USERS: CHANGE THESE VALUES FOR YOUR ENVIRONMENT
# =========================================================================
# PROJECT_ID: Your target Google Cloud project ID (replace "coba-sdlc" with your project ID)
PROJECT_ID="coba-sdlc"
# REGION: The GCP region where your Cloud Run service is deployed
REGION="us-central1"
# SERVICE_NAME: Name of the Cloud Run service to attach IAP to
SERVICE_NAME="codmod-gui"
# DOMAIN: The custom domain you want to use for the load balancer (e.g., codmod.mycompany.com)
DOMAIN="codmod.yourdomain.com"
# SUPPORT_EMAIL: Support email shown on the Google OAuth login consent screen
SUPPORT_EMAIL="admin@misbahh.altostrat.com"
# ALLOWED_DOMAIN: The Google Workspace domain allowed to log in via IAP (e.g., mycompany.com)
ALLOWED_DOMAIN="misbahh.altostrat.com"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}=== Starting Google Cloud IAP & Load Balancer Setup ===${NC}"

# Check if defaults were changed
if [ "$DOMAIN" == "codmod.yourdomain.com" ]; then
  echo -e "${RED}Error: Please open setup-iap.sh and configure your DOMAIN (e.g., codmod.mycompany.com).${NC}"
  exit 1
fi

# 1. Set Active Project
echo -e "\n${YELLOW}[1/10] Setting active project to: ${PROJECT_ID}...${NC}"
gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')


# 2. Enable Required APIs
echo -e "\n${YELLOW}[2/10] Enabling Compute and IAP APIs...${NC}"
gcloud services enable \
  compute.googleapis.com \
  iap.googleapis.com

# 3. Create Serverless Network Endpoint Group (NEG)
echo -e "\n${YELLOW}[3/10] Creating Serverless Network Endpoint Group (NEG)...${NC}"
NEG_NAME="${SERVICE_NAME}-neg"
if gcloud compute network-endpoint-groups describe "$NEG_NAME" --region="$REGION" &>/dev/null; then
  echo -e "${GREEN}NEG ${NEG_NAME} already exists.${NC}"
else
  gcloud compute network-endpoint-groups create "$NEG_NAME" \
    --region="$REGION" \
    --network-endpoint-type=serverless \
    --cloud-run-service="$SERVICE_NAME"
  echo -e "${GREEN}NEG created successfully.${NC}"
fi

# 4. Create Global Backend Service
echo -e "\n${YELLOW}[4/10] Creating Global Backend Service...${NC}"
BACKEND_NAME="${SERVICE_NAME}-backend"
if gcloud compute backend-services describe "$BACKEND_NAME" --global &>/dev/null; then
  echo -e "${GREEN}Backend service ${BACKEND_NAME} already exists.${NC}"
else
  gcloud compute backend-services create "$BACKEND_NAME" \
    --global \
    --load-balancing-scheme=EXTERNAL
  
  echo -e "Adding Serverless NEG backend to the backend service..."
  gcloud compute backend-services add-backend "$BACKEND_NAME" \
    --global \
    --network-endpoint-group="$NEG_NAME" \
    --network-endpoint-group-region="$REGION"
  echo -e "${GREEN}Backend service configured successfully.${NC}"
fi

# 5. Reserve Global Static IP Address
echo -e "\n${YELLOW}[5/10] Reserving Global Static IP Address...${NC}"
IP_NAME="${SERVICE_NAME}-ip"
if gcloud compute addresses describe "$IP_NAME" --global &>/dev/null; then
  echo -e "${GREEN}Static IP ${IP_NAME} already reserved.${NC}"
else
  gcloud compute addresses create "$IP_NAME" --global
  echo -e "${GREEN}Static IP reserved successfully.${NC}"
fi

IP_ADDRESS=$(gcloud compute addresses describe "$IP_NAME" --global --format="value(address)")
echo -e "Reserved IP Address: ${GREEN}${IP_ADDRESS}${NC}"

# 6. Create Google-Managed SSL Certificate
echo -e "\n${YELLOW}[6/10] Creating Google-Managed SSL Certificate for ${DOMAIN}...${NC}"
CERT_NAME="${SERVICE_NAME}-ssl-cert"
if gcloud compute ssl-certificates describe "$CERT_NAME" --global &>/dev/null; then
  echo -e "${GREEN}SSL Certificate ${CERT_NAME} already exists.${NC}"
else
  gcloud compute ssl-certificates create "$CERT_NAME" \
    --domains="$DOMAIN" \
    --global
  echo -e "${GREEN}SSL Certificate resource created. (Provisioning will complete once DNS is pointed).${NC}"
fi

# 7. Create URL Map (Load Balancer Route)
echo -e "\n${YELLOW}[7/10] Creating URL Map and Routing Rules...${NC}"
URL_MAP_NAME="${SERVICE_NAME}-url-map"
if gcloud compute url-maps describe "$URL_MAP_NAME" &>/dev/null; then
  echo -e "${GREEN}URL Map ${URL_MAP_NAME} already exists.${NC}"
else
  gcloud compute url-maps create "$URL_MAP_NAME" --default-service="$BACKEND_NAME"
  echo -e "${GREEN}URL Map created.${NC}"
fi

# 8. Create Target HTTPS Proxy & Global Forwarding Rule
echo -e "\n${YELLOW}[8/10] Creating HTTPS Proxy and Forwarding Rules...${NC}"
PROXY_NAME="${SERVICE_NAME}-https-proxy"
if gcloud compute target-https-proxies describe "$PROXY_NAME" &>/dev/null; then
  echo -e "${GREEN}HTTPS Proxy ${PROXY_NAME} already exists.${NC}"
else
  gcloud compute target-https-proxies create "$PROXY_NAME" \
    --url-map="$URL_MAP_NAME" \
    --ssl-certificates="$CERT_NAME"
  echo -e "${GREEN}HTTPS Proxy created.${NC}"
fi

FORWARDING_RULE_NAME="${SERVICE_NAME}-forwarding-rule"
if gcloud compute forwarding-rules describe "$FORWARDING_RULE_NAME" --global &>/dev/null; then
  echo -e "${GREEN}Forwarding rule ${FORWARDING_RULE_NAME} already exists.${NC}"
else
  gcloud compute forwarding-rules create "$FORWARDING_RULE_NAME" \
    --address="$IP_NAME" \
    --global \
    --target-https-proxy="$PROXY_NAME" \
    --ports=443
  echo -e "${GREEN}Global Forwarding Rule created successfully.${NC}"
fi

# 9. Configure IAP OAuth Brand and Client
echo -e "\n${YELLOW}[9/10] Setting up OAuth Consent Screen and Client for IAP...${NC}"

# Check if an OAuth Brand already exists in the project
BRAND_NAME=$(gcloud iap oauth-brands list --format="value(name)" | head -n 1 || true)

if [ -z "$BRAND_NAME" ]; then
  echo -e "No OAuth Brand found. Creating new OAuth Brand..."
  # Create brand (consent screen)
  gcloud iap oauth-brands create \
    --application_title="Google Codmod GUI" \
    --support_email="$SUPPORT_EMAIL"
  BRAND_NAME=$(gcloud iap oauth-brands list --format="value(name)" | head -n 1)
  echo -e "${GREEN}OAuth Brand created: ${BRAND_NAME}${NC}"
else
  echo -e "${GREEN}Existing OAuth Brand found: ${BRAND_NAME}${NC}"
fi

# Create OAuth Client under the brand for IAP
echo -e "Creating OAuth Client ID and Secret..."
CLIENT_JSON_FILE="/tmp/iap-client.json"
gcloud iap oauth-clients create "$BRAND_NAME" \
  --display_name="Codmod IAP Client" \
  --format="json" > "$CLIENT_JSON_FILE"

# Extract Client ID and Client Secret using grep/sed (to avoid requiring jq)
CLIENT_ID=$(grep -o '"name": "[^"]*' "$CLIENT_JSON_FILE" | cut -d'"' -f4 | sed 's/.*\///')
CLIENT_SECRET=$(grep -o '"secret": "[^"]*' "$CLIENT_JSON_FILE" | cut -d'"' -f4)
rm -f "$CLIENT_JSON_FILE"

echo -e "OAuth Client ID: ${GREEN}${CLIENT_ID}${NC}"

# 10. Enable IAP on the Backend Service
echo -e "\n${YELLOW}[10/10] Enabling Identity-Aware Proxy (IAP) on Load Balancer...${NC}"
gcloud compute backend-services update "$BACKEND_NAME" \
  --global \
  --iap=enabled,oauth2-client-id="$CLIENT_ID",oauth2-client-secret="$CLIENT_SECRET"

# Add IAM policy binding to let members of the Workspace domain access the app
echo -e "Granting IAP Access to all users in domain: ${BLUE}${ALLOWED_DOMAIN}${NC}..."
gcloud iap web add-iam-policy-binding \
  --resource-type=backend-services \
  --service="$BACKEND_NAME" \
  --member="domain:${ALLOWED_DOMAIN}" \
  --role="roles/iap.httpsResourceAccessor"

# 10b. Grant Cloud Run Invoker role to the IAP Service Agent
echo -e "\n${YELLOW}[10b/10] Granting Cloud Run Invoker role to IAP Service Agent...${NC}"
IAP_SERVICE_ACCOUNT="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"
echo -e "Granting ${YELLOW}Cloud Run Invoker (roles/run.invoker)${NC} to IAP Service Agent: ${BLUE}${IAP_SERVICE_ACCOUNT}${NC}..."
gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
  --region="$REGION" \
  --member="serviceAccount:${IAP_SERVICE_ACCOUNT}" \
  --role="roles/run.invoker"


echo -e "\n${GREEN}=== IAP & LOAD BALANCER CONFIGURATION COMPLETED ===${NC}"
echo -e "-----------------------------------------------------------------"
echo -e "1. ${YELLOW}IMPORTANT DNS CONFIGURATION REQUIREMENT:${NC}"
echo -e "   Log in to your DNS registrar (e.g., Google Domains, GoDaddy, Route53) and add an ${BLUE}A-record${NC}:"
echo -e "   Host: ${BLUE}$(echo "$DOMAIN" | cut -d'.' -f1)${NC} (or the full subdomain)"
echo -e "   Value: ${GREEN}${IP_ADDRESS}${NC}"
echo -e "-----------------------------------------------------------------"
echo -e "2. Once DNS is pointed, Google will automatically provision the SSL certificate (takes 10-30 mins)."
echo -e "3. After that, you can visit: ${GREEN}https://${DOMAIN}${NC} to log in securely with your Google Workspace account!"
echo -e "-----------------------------------------------------------------"
