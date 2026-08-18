// Client-side Application Logic for Google Codmod Web Wrapper

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const form = document.getElementById('assessment-form');
  const submitBtn = document.getElementById('submit-btn');
  const logOutput = document.getElementById('log-output');
  const terminalJobId = document.getElementById('terminal-job-id');
  const clearTerminalBtn = document.getElementById('clear-terminal-btn');
  const refreshHistoryBtn = document.getElementById('refresh-history-btn');
  const jobsTableBody = document.getElementById('jobs-table-body');
  
  // Modal Elements
  const reportModal = document.getElementById('report-modal');
  const reportFrame = document.getElementById('report-frame');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const modalReportTitle = document.getElementById('modal-report-title');
  const modalDownloadBtn = document.getElementById('modal-download-btn');

  let activeEventSource = null;
  let pollIntervalId = null;

  const statusIndicator = document.getElementById('system-status-indicator');

  function updateSystemStatus(status, text) {
    if (!statusIndicator) return;
    if (status === 'active') {
      statusIndicator.textContent = text || 'Assessment in Progress';
      statusIndicator.className = 'status-pill active-pill';
      statusIndicator.style.background = 'rgba(52, 168, 83, 0.15)';
      statusIndicator.style.color = '#34A853';
      statusIndicator.style.borderColor = '#34A853';
    } else if (status === 'ready') {
      statusIndicator.textContent = text || 'System Ready';
      statusIndicator.className = 'status-pill active-pill';
      statusIndicator.style.background = 'rgba(66, 133, 244, 0.1)';
      statusIndicator.style.color = '#1a73e8';
      statusIndicator.style.borderColor = '#4285F4';
    } else {
      statusIndicator.textContent = text || 'System Offline';
      statusIndicator.className = 'status-pill';
      statusIndicator.style.background = 'rgba(234, 67, 53, 0.1)';
      statusIndicator.style.color = '#EA4335';
      statusIndicator.style.borderColor = '#EA4335';
    }
  }

  // ==========================================
  // GCP TARGET SETTINGS CLIENT-SIDE CACHING
  // ==========================================
  const gcsBucketInput = document.getElementById('gcs-bucket');
  const gcpProjectInput = document.getElementById('gcp-project');
  const gcpRegionInput = document.getElementById('gcp-region');

  // Automatically load cached values on page refresh
  try {
    const cachedBucket = localStorage.getItem('codmod_gcs_bucket');
    const cachedProject = localStorage.getItem('codmod_gcp_project');
    const cachedRegion = localStorage.getItem('codmod_gcp_region');

    if (cachedBucket && gcsBucketInput) gcsBucketInput.value = cachedBucket;
    if (cachedProject && gcpProjectInput) gcpProjectInput.value = cachedProject;
    if (cachedRegion && gcpRegionInput) gcpRegionInput.value = cachedRegion;
  } catch (e) {
    // Ignore localStorage errors (e.g. in restricted browsing mode)
  }

  // Save values immediately when the user types or changes any GCP target field
  function saveGcpSettingsToCache() {
    try {
      if (gcsBucketInput && gcsBucketInput.value.trim()) {
        localStorage.setItem('codmod_gcs_bucket', gcsBucketInput.value.trim());
      }
      if (gcpProjectInput) {
        localStorage.setItem('codmod_gcp_project', gcpProjectInput.value.trim());
      }
      if (gcpRegionInput && gcpRegionInput.value.trim()) {
        localStorage.setItem('codmod_gcp_region', gcpRegionInput.value.trim());
      }
    } catch (e) {}
  }

  if (gcsBucketInput) gcsBucketInput.addEventListener('input', saveGcpSettingsToCache);
  if (gcpProjectInput) gcpProjectInput.addEventListener('input', saveGcpSettingsToCache);
  if (gcpRegionInput) gcpRegionInput.addEventListener('input', saveGcpSettingsToCache);

  // ==========================================
  // API FUNCTIONS
  // ==========================================

  // ==========================================
  // SOURCE TYPE SWITCHER & FOLDER BROWSER
  // ==========================================
  const sourceTypeRadios = document.querySelectorAll('input[name="source-type"]');
  const typeGitLabel = document.getElementById('type-git-label');
  const typeLocalLabel = document.getElementById('type-local-label');
  const gitSection = document.getElementById('git-source-section');
  const localSection = document.getElementById('local-source-section');
  const gitUrlInput = document.getElementById('git-url');
  const localPathInput = document.getElementById('local-path');

  if (sourceTypeRadios.length > 0) {
    sourceTypeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        const selected = e.target.value;
        if (selected === 'git') {
          typeGitLabel.classList.add('active');
          typeLocalLabel.classList.remove('active');
          gitSection.hidden = false;
          localSection.hidden = true;
          gitUrlInput.required = true;
          localPathInput.required = false;
        } else {
          typeGitLabel.classList.remove('active');
          typeLocalLabel.classList.add('active');
          gitSection.hidden = true;
          localSection.hidden = false;
          gitUrlInput.required = false;
          localPathInput.required = true;
        }
      });
    });
  }

  // Windows/Mac Explorer style Folder Modal logic
  const browseFolderBtn = document.getElementById('browse-folder-btn');
  const folderModal = document.getElementById('folder-browse-modal');
  const folderCloseBtn = document.getElementById('folder-modal-close-btn');
  const folderCancelBtn = document.getElementById('folder-cancel-btn');
  const folderConfirmBtn = document.getElementById('folder-select-confirm-btn');
  const folderUpBtn = document.getElementById('folder-up-btn');
  const folderCurrentPathSpan = document.getElementById('folder-current-path');
  const folderSelectedPathStrong = document.getElementById('folder-selected-path');
  const folderListContainer = document.getElementById('folder-list-container');

  let currentBrowsedDir = '/repos';
  let selectedFolderPath = null;

  async function loadFolderList(dirPath) {
    try {
      folderListContainer.innerHTML = '<div style="padding: 1rem; color: var(--text-secondary);">Loading folders...</div>';
      const response = await fetch(`/api/fs/browse?dir=${encodeURIComponent(dirPath || '')}`);
      const data = await response.json();

      if (!response.ok) {
        folderListContainer.innerHTML = `<div style="padding: 1rem; color: #ea4335;">Error: ${data.error || 'Failed to read directory.'}</div>`;
        return;
      }

      currentBrowsedDir = data.currentDir;
      folderCurrentPathSpan.textContent = currentBrowsedDir;

      if (data.parentDir) {
        folderUpBtn.disabled = false;
        folderUpBtn.onclick = () => loadFolderList(data.parentDir);
      } else {
        folderUpBtn.disabled = true;
        folderUpBtn.onclick = null;
      }

      folderListContainer.innerHTML = '';

      if (data.directories.length === 0) {
        folderListContainer.innerHTML = '<div style="padding: 1rem; color: var(--text-secondary);">No subfolders found in this directory.</div>';
        return;
      }

      data.directories.forEach(item => {
        const div = document.createElement('div');
        div.className = 'folder-item';
        div.innerHTML = `<span class="folder-item-icon">📁</span><span class="folder-item-name">${item.name}</span>`;
        
        div.addEventListener('click', () => {
          document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('selected'));
          div.classList.add('selected');
          selectedFolderPath = item.path;
          folderSelectedPathStrong.textContent = item.path;
          folderConfirmBtn.disabled = false;
        });

        div.addEventListener('dblclick', () => {
          loadFolderList(item.path);
        });

        folderListContainer.appendChild(div);
      });

    } catch (err) {
      folderListContainer.innerHTML = `<div style="padding: 1rem; color: #ea4335;">Failed to load folder contents.</div>`;
    }
  }

  if (browseFolderBtn) {
    browseFolderBtn.addEventListener('click', () => {
      selectedFolderPath = null;
      folderSelectedPathStrong.textContent = 'None';
      folderConfirmBtn.disabled = true;
      folderModal.hidden = false;
      loadFolderList(localPathInput.value.trim() || '/repos');
    });
  }

  function closeFolderModal() {
    folderModal.hidden = true;
  }

  if (folderCloseBtn) folderCloseBtn.addEventListener('click', closeFolderModal);
  if (folderCancelBtn) folderCancelBtn.addEventListener('click', closeFolderModal);

  if (folderConfirmBtn) {
    folderConfirmBtn.addEventListener('click', () => {
      if (selectedFolderPath) {
        localPathInput.value = selectedFolderPath;
      }
      closeFolderModal();
    });
  }

  // ==========================================
  // COST ESTIMATE MODAL & BUTTON HANDLER
  // ==========================================
  const costEstimateModal = document.getElementById('cost-estimate-modal');
  const costAmountValue = document.getElementById('cost-amount-value');
  const costModalCloseBtn = document.getElementById('cost-modal-close-btn');
  const costCancelBtn = document.getElementById('cost-cancel-btn');
  const costProceedBtn = document.getElementById('cost-proceed-btn');

  function openCostEstimateModal(costStr) {
    if (costAmountValue) costAmountValue.textContent = costStr || '$0.00 USD';
    if (costEstimateModal) costEstimateModal.hidden = false;
  }

  function closeCostEstimateModal() {
    if (costEstimateModal) costEstimateModal.hidden = true;
  }

  if (costModalCloseBtn) costModalCloseBtn.addEventListener('click', closeCostEstimateModal);
  if (costCancelBtn) costCancelBtn.addEventListener('click', closeCostEstimateModal);
  if (costProceedBtn) {
    costProceedBtn.addEventListener('click', () => {
      closeCostEstimateModal();
      if (form) form.requestSubmit();
    });
  }

  const estimateCostBtn = document.getElementById('estimate-cost-btn');
  if (estimateCostBtn) {
    estimateCostBtn.addEventListener('click', async () => {
      saveGcpSettingsToCache();

      const sourceTypeEl = document.querySelector('input[name="source-type"]:checked');
      const sourceType = sourceTypeEl ? sourceTypeEl.value : 'git';
      const repoUrl = document.getElementById('git-url').value.trim();
      const branch = document.getElementById('git-branch').value.trim();
      const gitUsername = document.getElementById('git-username').value.trim();
      const gitPassword = document.getElementById('git-password').value;
      const localPath = document.getElementById('local-path').value.trim();

      if (sourceType === 'git' && !repoUrl) {
        alert('Please enter a valid Git Repository URL to estimate cost.');
        return;
      }
      if (sourceType === 'local' && !localPath) {
        alert('Please select or enter a Local Repository Folder Path to estimate cost.');
        return;
      }

      const project = document.getElementById('gcp-project').value.trim();
      const region = document.getElementById('gcp-region').value.trim();
      const reportType = document.getElementById('report-type').value;
      const modelset = document.getElementById('model-set').value;
      const format = document.getElementById('report-format').value;
      const intent = document.getElementById('modernization-intent').value;
      const context = document.getElementById('custom-context').value.trim();

      const optionalSections = [];
      document.querySelectorAll('input[name="optional-sections"]:checked').forEach(cb => {
        optionalSections.push(cb.value);
      });

      const requestPayload = {
        sourceType,
        repoUrl: sourceType === 'local' ? `local://${localPath}` : repoUrl,
        localPath: sourceType === 'local' ? localPath : null,
        branch: sourceType === 'local' ? null : (branch || null),
        gitUsername: sourceType === 'git' && gitUsername ? gitUsername : null,
        gitPassword: sourceType === 'git' && gitPassword ? gitPassword : null,
        options: {
          reportType,
          modelset,
          format,
          project: project || null,
          region: region || null,
          intent: intent || null,
          optionalSections,
          context: context || null
        }
      };

      try {
        estimateCostBtn.disabled = true;
        estimateCostBtn.querySelector('span').textContent = 'Estimating...';
        updateSystemStatus('active', 'Estimating Assessment Cost...');

        const response = await fetch('/api/estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestPayload)
        });

        const result = await response.json();

        if (!response.ok) {
          alert('Failed to trigger cost estimation: ' + (result.error || 'Unknown error'));
          estimateCostBtn.disabled = false;
          estimateCostBtn.querySelector('span').textContent = 'Estimate Cost';
          updateSystemStatus('ready', 'System Ready');
          return;
        }

        clearTerminal();
        startLogStream(result.jobId);
      } catch (err) {
        alert('Error communicating with server: ' + err.message);
        estimateCostBtn.disabled = false;
        estimateCostBtn.querySelector('span').textContent = 'Estimate Cost';
        updateSystemStatus('ready', 'System Ready');
      }
    });
  }

  // Submit Job
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveGcpSettingsToCache();

    // Collect form data
    const sourceTypeEl = document.querySelector('input[name="source-type"]:checked');
    const sourceType = sourceTypeEl ? sourceTypeEl.value : 'git';

    const repoUrl = document.getElementById('git-url').value.trim();
    const branch = document.getElementById('git-branch').value.trim();
    const gitUsername = document.getElementById('git-username').value.trim();
    const gitPassword = document.getElementById('git-password').value;
    const localPath = document.getElementById('local-path').value.trim();
    const gcsBucket = document.getElementById('gcs-bucket').value.trim();
    
    // Collapsible options
    const project = document.getElementById('gcp-project').value.trim();
    const region = document.getElementById('gcp-region').value.trim();
    const reportType = document.getElementById('report-type').value;
    const modelset = document.getElementById('model-set').value;
    const format = document.getElementById('report-format').value;
    const intent = document.getElementById('modernization-intent').value;
    const context = document.getElementById('custom-context').value.trim();

    // Checkboxes
    const optionalSections = [];
    document.querySelectorAll('input[name="optional-sections"]:checked').forEach(cb => {
      optionalSections.push(cb.value);
    });

    const requestPayload = {
      sourceType,
      repoUrl: sourceType === 'local' ? `local://${localPath}` : repoUrl,
      localPath: sourceType === 'local' ? localPath : null,
      branch: sourceType === 'local' ? null : (branch || null),
      gitUsername: sourceType === 'git' && gitUsername ? gitUsername : null,
      gitPassword: sourceType === 'git' && gitPassword ? gitPassword : null,
      gcsBucket,
      options: {
        reportType,
        modelset,
        format,
        project: project || null,
        region: region || null,
        intent: intent || null,
        optionalSections,
        context: context || null
      }
    };

    try {
      // Disable submit button and show loading state
      submitBtn.disabled = true;
      submitBtn.querySelector('span').textContent = 'Queueing Assessment...';

      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestPayload)
      });

      const result = await response.json();

      if (!response.ok) {
        if (response.status === 409 && result.duplicate) {
          const completedAtDate = new Date(result.completedAt);
          const formattedDate = completedAtDate.toLocaleString();
          
          const confirmMsg = `An assessment report for this repository was already successfully generated on:\n${formattedDate}\n\n` +
            `• Click OK to view the existing HTML report.\n` +
            `• Click Cancel to run a new assessment anyway.`;
          
          if (confirm(confirmMsg)) {
            openReportModal(result.existingJobId, requestPayload.repoUrl, result.format || 'html');
            return;
          } else {
            // Re-submit with force: true
            requestPayload.force = true;
            submitBtn.disabled = true;
            submitBtn.querySelector('span').textContent = 'Queueing Assessment...';
            
            const retryResponse = await fetch('/api/jobs', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(requestPayload)
            });
            
            const retryResult = await retryResponse.json();
            if (!retryResponse.ok) {
              throw new Error(retryResult.error || 'Failed to trigger assessment');
            }
            
            addTerminalLine('system', `Job successfully queued! Assigned Job ID: ${retryResult.jobId}`);
            startLogStream(retryResult.jobId);
            fetchJobsHistory();
            startAutoPolling();
            return;
          }
        }
        throw new Error(result.error || 'Failed to trigger assessment');
      }

      // Success
      addTerminalLine('system', `Job successfully queued! Assigned Job ID: ${result.jobId}`);
      // Connect to SSE log stream
      startLogStream(result.jobId);
      // Refresh list
      fetchJobsHistory();
      // Start auto polling while job is running
      startAutoPolling();

    } catch (err) {
      addTerminalLine('stderr', `Error triggering assessment: ${err.message}`);
      alert(`Error: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.querySelector('span').textContent = 'Run Modernization Assessment';
    }
  });

  // Fetch Job History
  async function fetchJobsHistory() {
    try {
      const response = await fetch('/api/jobs');
      if (!response.ok) throw new Error('Failed to fetch history');
      const jobs = await response.json();
      renderJobsTable(jobs);

      // Check if any job is still running
      const hasActiveJobs = jobs.some(j => ['queued', 'started', 'cloning', 'analyzing', 'uploading'].includes(j.status));
      if (hasActiveJobs) {
        updateSystemStatus('active', 'Assessment in Progress');
        startAutoPolling();
      } else {
        updateSystemStatus('ready', 'System Ready');
        if (!activeEventSource) {
          stopAutoPolling();
        }
      }
    } catch (err) {
      console.error('Error fetching job history:', err);
      updateSystemStatus('error', 'Connection Offline');
    }
  }

  // ==========================================
  // REAL-TIME LOG STREAMING (SSE)
  // ==========================================

  function startLogStream(jobId) {
    // Close existing connection if any
    if (activeEventSource) {
      activeEventSource.close();
    }

    clearTerminal();
    terminalJobId.textContent = `Job ID: ${jobId}`;
    addTerminalLine('system', `Subscribing to live log stream for Job: ${jobId}...`);

    activeEventSource = new EventSource(`/api/jobs/${jobId}/logs`);

    activeEventSource.onmessage = (event) => {
      try {
        const logEntry = JSON.parse(event.data);
        addTerminalLine(logEntry.source, logEntry.message, logEntry.time);
      } catch (err) {
        console.error('Error parsing SSE data:', err);
      }
    };

    activeEventSource.addEventListener('end', async (event) => {
      addTerminalLine('system', 'Assessment execution completed. Log stream closed.');
      activeEventSource.close();
      activeEventSource = null;
      terminalJobId.textContent = 'No Active Job';

      // Check if this was a cost estimate job
      try {
        const resp = await fetch(`/api/jobs/${jobId}`);
        if (resp.ok) {
          const jobData = await resp.json();
          if (jobData.estimateOnly && jobData.estimatedCost) {
            openCostEstimateModal(jobData.estimatedCost);
            updateSystemStatus('ready', `Estimate Complete: ${jobData.estimatedCost}`);
            const estimateBtn = document.getElementById('estimate-cost-btn');
            if (estimateBtn) {
              estimateBtn.disabled = false;
              estimateBtn.querySelector('span').textContent = 'Estimate Cost';
            }
          }
        }
      } catch (err) {}

      fetchJobsHistory(); // Final refresh
    });

    activeEventSource.onerror = (err) => {
      console.error('EventSource encountered an error:', err);
      addTerminalLine('stderr', 'Connection to log stream lost. Attempting reconnect...');
    };
  }

  // ==========================================
  // DOM RENDERING & SAFE UTILITIES
  // ==========================================

  // Safe terminal printing to prevent XSS (uses textContent)
  function addTerminalLine(source, message, timeStamp = new Date()) {
    const line = document.createElement('div');
    line.className = `term-line term-${source}`;

    // Timestamp
    const timeSpan = document.createElement('span');
    timeSpan.className = 'term-time';
    const parsedTime = new Date(timeStamp);
    timeSpan.textContent = `[${parsedTime.toLocaleTimeString()}]`;
    line.appendChild(timeSpan);

    // Source prefix if system
    if (source === 'system') {
      const sourceSpan = document.createElement('span');
      sourceSpan.className = 'term-system';
      sourceSpan.textContent = '[system] ';
      line.appendChild(sourceSpan);
    }

    // Message Content (Safe text node)
    const textNode = document.createTextNode(message);
    line.appendChild(textNode);

    logOutput.appendChild(line);
    // Auto scroll to bottom
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  function clearTerminal() {
    logOutput.replaceChildren(); // Safely clears all children
  }

  // Render Job History Table (strictly using safe DOM APIs)
  function renderJobsTable(jobs) {
    jobsTableBody.replaceChildren();

    if (jobs.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'table-empty';
      td.textContent = 'No jobs ran yet. Run an assessment to see history.';
      tr.appendChild(td);
      jobsTableBody.appendChild(tr);
      return;
    }

    // Sort jobs: newest first
    jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    jobs.forEach(job => {
      const tr = document.createElement('tr');

      // Repository URL
      const tdRepo = document.createElement('td');
      tdRepo.className = 'td-repo';
      tdRepo.title = job.repoUrl || job.localPath || 'Unknown';
      if (job.sourceType === 'local' || (job.repoUrl && job.repoUrl.startsWith('local://'))) {
        tdRepo.textContent = '📁 ' + (job.localPath || job.repoUrl.replace('local://', ''));
      } else {
        tdRepo.textContent = job.repoUrl;
      }
      tr.appendChild(tdRepo);

      // GCS Bucket
      const tdBucket = document.createElement('td');
      tdBucket.textContent = job.gcsBucket;
      tr.appendChild(tdBucket);

      // Report Type
      const tdType = document.createElement('td');
      tdType.textContent = job.options.reportType.toUpperCase();
      tr.appendChild(tdType);

      // Status Badge
      const tdStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge-status badge-${job.status}`;
      badge.textContent = job.status;
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      // Created At
      const tdCreated = document.createElement('td');
      const createdTime = new Date(job.createdAt);
      tdCreated.textContent = createdTime.toLocaleString();
      tr.appendChild(tdCreated);

      // Actions
      const tdActions = document.createElement('td');
      const actionGroup = document.createElement('div');
      actionGroup.className = 'action-group';

      // 1. View Logs Button
      const btnLogs = document.createElement('button');
      btnLogs.className = 'btn-table-action';
      btnLogs.textContent = 'Logs';
      btnLogs.addEventListener('click', () => {
        startLogStream(job.id);
        // Scroll terminal into view on small screens
        document.getElementById('terminal-section').scrollIntoView({ behavior: 'smooth' });
      });
      actionGroup.appendChild(btnLogs);

      // 2. View Report Button (Only if completed)
      const btnReport = document.createElement('button');
      btnReport.className = 'btn-table-action';
      btnReport.textContent = 'View Report';
      btnReport.disabled = job.status !== 'completed';
      btnReport.addEventListener('click', () => {
        openReportModal(job.id, job.repoUrl, job.options.format);
      });
      actionGroup.appendChild(btnReport);

      tdActions.appendChild(actionGroup);
      tr.appendChild(tdActions);

      jobsTableBody.appendChild(tr);
    });
  }

  // ==========================================
  // MODAL REPORT VIEWER
  // ==========================================

  function openReportModal(jobId, repoName, format) {
    modalReportTitle.textContent = `Modernization Report: ${repoName.split('/').pop()}`;
    
    // Set download link
    modalDownloadBtn.href = `/api/jobs/${jobId}/report`;
    
    if (format === 'html') {
      // Stream the report HTML inside the sandboxed iframe
      reportFrame.src = `/api/jobs/${jobId}/report`;
      reportFrame.hidden = false;
    } else {
      // If it's markdown or JSON, we just redirect or open download in new tab
      reportFrame.src = 'about:blank';
      reportFrame.hidden = true;
      window.open(`/api/jobs/${jobId}/report`, '_blank');
      return;
    }

    reportModal.removeAttribute('hidden');
  }

  function closeReportModal() {
    reportModal.setAttribute('hidden', '');
    reportFrame.src = 'about:blank';
  }

  // ==========================================
  // POLLING & REFRESH LOOPS
  // ==========================================

  function startAutoPolling() {
    if (pollIntervalId) return; // Already polling
    console.log('Starting background status polling...');
    pollIntervalId = setInterval(fetchJobsHistory, 3000); // Poll every 3 seconds
  }

  function stopAutoPolling() {
    if (pollIntervalId) {
      console.log('Stopping background status polling.');
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
  }

  // ==========================================
  // INITIALIZATIONS & EVENT LISTENERS
  // ==========================================

  // Clear terminal action
  clearTerminalBtn.addEventListener('click', () => {
    clearTerminal();
    addTerminalLine('system', 'Console cleared by user.');
  });

  // Refresh history action
  refreshHistoryBtn.addEventListener('click', () => {
    fetchJobsHistory();
  });

  // Modal actions
  modalCloseBtn.addEventListener('click', closeReportModal);
  reportModal.addEventListener('click', (e) => {
    if (e.target === reportModal) closeReportModal();
  });

  // Logout action
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/logout', { method: 'POST' });
        if (response.ok) {
          window.location.href = '/login.html';
        }
      } catch (err) {
        console.error('Logout error:', err);
      }
    });
  }

  // Initial Fetch
  fetchJobsHistory();
});

