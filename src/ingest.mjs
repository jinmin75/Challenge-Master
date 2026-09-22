const RESULT_STATUSES = new Set(['ready', 'needs_review', 'failed']);

export function createManifest(input) {
  const source = normalizeSource(input);
  return deepFreeze({
    kind: 'pdf_markdown_manifest',
    schemaVersion: 1,
    source,
    provenance: { ...source },
    pages: {}
  });
}

export function applyPageResult(manifest, result) {
  assertManifest(manifest);
  const page = normalizePageResult(manifest, result);
  const key = String(page.pdfPageIndex);
  const current = manifest.pages[key];

  if (current) {
    if (stableStringify(current.input) === stableStringify(page.input)) return manifest;
    if (current.status === 'ready') {
      throw new Error(`page ${key} result conflict: ready pages are immutable`);
    }
  }

  return deepFreeze({
    ...manifest,
    pages: {
      ...manifest.pages,
      [key]: page
    }
  });
}

export function summarizeManifest(manifest) {
  assertManifest(manifest);
  const selected = manifest.source.selectedPages;
  const pageValues = selected.map((page) => manifest.pages[String(page)]).filter(Boolean);
  const readyPages = pagesWithStatus(manifest, 'ready');
  const needsReviewPages = pagesWithStatus(manifest, 'needs_review');
  const failedPages = pagesWithStatus(manifest, 'failed');
  const missingPages = selected.filter((page) => !manifest.pages[String(page)]);
  const status = pageValues.length === 0
    ? 'not_started'
    : readyPages.length === selected.length
      ? 'ready'
      : 'partial';

  return {
    sourceId: manifest.source.sourceId,
    sourceHash: manifest.source.sourceHash,
    conversionVersion: manifest.source.conversionVersion,
    selectedPages: [...selected],
    readyPages,
    needsReviewPages,
    failedPages,
    missingPages,
    status,
    masteryEvidence: false
  };
}

export function renderFaithfulMarkdown(manifest) {
  const summary = summarizeManifest(manifest);
  const lines = [
    `<!-- source_id: ${escapeComment(manifest.source.sourceId)} -->`,
    `<!-- source_hash: ${escapeComment(manifest.source.sourceHash)} -->`,
    `<!-- conversion_version: ${escapeComment(manifest.source.conversionVersion)} -->`,
    `<!-- partial_status: ${summary.status} -->`,
    ''
  ];

  for (const pageNumber of manifest.source.selectedPages) {
    const page = manifest.pages[String(pageNumber)];
    if (!page || page.status !== 'ready') continue;
    lines.push(`<!-- page_anchor: source:${escapeComment(manifest.source.sourceId)}#pdf-page-${page.pdfPageIndex} -->`);
    lines.push(`<!-- printed_page_label: ${escapeComment(page.printedPageLabel)} -->`);
    lines.push(`<!-- block_id: ${escapeComment(page.blocks[0].blockId)} -->`);
    lines.push(page.markdown);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function canTransmit({ consent, provider, sourceId, operation, rightsAllowExternal, now }) {
  if (rightsAllowExternal !== true) return false;
  if (!isNonEmptyString(provider) || !isNonEmptyString(sourceId) || !isNonEmptyString(operation)) return false;
  if (!isValidConsent(consent)) return false;
  if (consent.provider !== provider) return false;
  if (!consent.source_ids.includes(sourceId)) return false;
  if (!consent.allowed_operations.includes(operation)) return false;

  const nowTime = parseCanonicalInstant(now);
  const grantedTime = parseCanonicalInstant(consent.granted_at);
  if (!Number.isFinite(nowTime) || !Number.isFinite(grantedTime)) return false;
  if (grantedTime > nowTime) return false;
  if (consent.revoked_at !== null) {
    return false;
  }

  return true;
}

function normalizeSource(input) {
  if (!input || typeof input !== 'object') throw new Error('manifest input is required');
  const source = {
    sourceId: requiredString(input.sourceId, 'sourceId'),
    sourceHash: requiredHash(input.sourceHash, 'sourceHash'),
    title: requiredString(input.title, 'title'),
    edition: requiredString(input.edition, 'edition'),
    totalPages: requiredPositiveInteger(input.totalPages, 'totalPages'),
    selectedPages: normalizeSelectedPages(input.selectedPages, input.totalPages),
    conversionVersion: requiredString(input.conversionVersion, 'conversionVersion')
  };
  return source;
}

function normalizeSelectedPages(selectedPages, totalPages) {
  if (!Array.isArray(selectedPages) || selectedPages.length === 0) {
    throw new Error('selectedPages must be a non-empty array');
  }
  const seen = new Set();
  let previous = 0;
  for (const page of selectedPages) {
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      throw new Error('selectedPages must contain 1-based page numbers within totalPages');
    }
    if (seen.has(page)) throw new Error('duplicate selectedPages are not allowed');
    if (page <= previous) throw new Error('selectedPages must be sorted in ascending order');
    seen.add(page);
    previous = page;
  }
  return [...selectedPages];
}

function normalizePageResult(manifest, result) {
  if (!result || typeof result !== 'object') throw new Error('page result is required');
  if (result.sourceId !== undefined && result.sourceId !== manifest.source.sourceId) {
    throw new Error('source_id mismatch');
  }
  if (result.sourceHash !== undefined && result.sourceHash !== manifest.source.sourceHash) {
    throw new Error('source_hash mismatch');
  }
  if (result.conversionVersion !== undefined && result.conversionVersion !== manifest.source.conversionVersion) {
    throw new Error('conversion_version mismatch');
  }

  const pdfPageIndex = requiredPositiveInteger(result.pdfPageIndex, 'pdfPageIndex');
  if (!manifest.source.selectedPages.includes(pdfPageIndex)) {
    throw new Error('pdfPageIndex must be inside selectedPages');
  }
  const status = requiredString(result.status, 'status');
  if (!RESULT_STATUSES.has(status)) throw new Error('status is unsupported');

  const markdown = typeof result.markdown === 'string' ? result.markdown : '';
  const validation = normalizeValidation(result.validation);
  if (status === 'ready') {
    if (markdown.trim() === '') throw new Error('ready page requires non-empty markdown');
    if (!validation.structureChecked || !validation.sourceCompared) {
      throw new Error('ready page requires structure and source validation');
    }
    if (validation.issues.length > 0) {
      throw new Error('ready page cannot keep unresolved validation issues');
    }
  }

  const printedPageLabel = result.printedPageLabel === undefined || result.printedPageLabel === null
    ? 'unknown'
    : String(result.printedPageLabel);
  const blockId = `${manifest.source.sourceId}--${manifest.source.conversionVersion}--pdf-${pdfPageIndex}--block-1`;
  const input = {
    pdfPageIndex,
    printedPageLabel,
    markdown,
    status,
    validation
  };

  return {
    input,
    pdfPageIndex,
    printedPageLabel,
    markdown,
    status,
    validation,
    blocks: [{
      sourceId: manifest.source.sourceId,
      sourceHash: manifest.source.sourceHash,
      conversionVersion: manifest.source.conversionVersion,
      pdfPageIndex,
      printedPageLabel,
      blockId
    }]
  };
}

function normalizeValidation(validation) {
  if (!validation || typeof validation !== 'object') throw new Error('validation is required');
  if (typeof validation.structureChecked !== 'boolean') throw new Error('validation.structureChecked must be boolean');
  if (typeof validation.sourceCompared !== 'boolean') throw new Error('validation.sourceCompared must be boolean');
  if (!Array.isArray(validation.issues) || !validation.issues.every((issue) => typeof issue === 'string')) {
    throw new Error('validation.issues must be an array of strings');
  }
  return {
    structureChecked: validation.structureChecked,
    sourceCompared: validation.sourceCompared,
    issues: [...validation.issues]
  };
}

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.kind !== 'pdf_markdown_manifest') {
    throw new Error('manifest is required');
  }
  const allowedKeys = new Set(['kind', 'schemaVersion', 'source', 'provenance', 'pages']);
  for (const key of Object.keys(manifest)) {
    if (!allowedKeys.has(key)) throw new Error('manifest schema has unknown fields');
  }
  if (manifest.schemaVersion !== 1) throw new Error('manifest schema version is unsupported');
  if (!manifest.source || !manifest.provenance || !manifest.pages || typeof manifest.pages !== 'object') {
    throw new Error('manifest is malformed');
  }
  if (stableStringify(manifest.source) !== stableStringify(manifest.provenance)) {
    throw new Error('manifest source provenance was changed');
  }
  normalizeSource(manifest.source);
  for (const [key, page] of Object.entries(manifest.pages)) {
    const pageNumber = Number(key);
    if (!Number.isInteger(pageNumber) || String(pageNumber) !== key) throw new Error('manifest page key is invalid');
    if (!manifest.source.selectedPages.includes(pageNumber)) throw new Error('manifest contains unselected page data');
    const normalized = normalizePageResult(manifest, page?.input);
    if (normalized.pdfPageIndex !== pageNumber) throw new Error('manifest page key mismatch');
    if (stableStringify(normalized) !== stableStringify(page)) {
      throw new Error('manifest page record is malformed');
    }
  }
}

function pagesWithStatus(manifest, status) {
  return manifest.source.selectedPages.filter((page) => manifest.pages[String(page)]?.status === status);
}

function requiredString(value, field) {
  if (!isNonEmptyString(value)) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requiredHash(value, field) {
  if (!isNonEmptyString(value) || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${field} must be a 64-character SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function requiredPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidConsent(consent) {
  return Boolean(
    consent &&
    typeof consent === 'object' &&
    isNonEmptyString(consent.consent_id) &&
    isNonEmptyString(consent.provider) &&
    Array.isArray(consent.source_ids) &&
    consent.source_ids.every(isNonEmptyString) &&
    Array.isArray(consent.allowed_operations) &&
    consent.allowed_operations.every(isNonEmptyString) &&
    isNonEmptyString(consent.granted_at) &&
    (consent.revoked_at === null || isNonEmptyString(consent.revoked_at)) &&
    isNonEmptyString(consent.policy_version)
  );
}

function escapeComment(value) {
  return String(value).replaceAll('--', '- -');
}

function parseCanonicalInstant(value) {
  if (!isNonEmptyString(value)) return Number.NaN;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return Number.NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  if (new Date(parsed).toISOString() !== value) return Number.NaN;
  return parsed;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
