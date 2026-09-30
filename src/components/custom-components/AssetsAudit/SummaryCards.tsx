import React from 'react';
import intl from 'react-intl-universal';
import { AssetsAuditResult } from '../../../utils/custom-interfaces/AuditTypes';
import { fmtSize } from '../../../utils/custom-utils/formatters';

interface SummaryCardsProps {
  result: AssetsAuditResult;
}

const SummaryCards: React.FC<SummaryCardsProps> = ({ result }) => {
  // Count per-occurrence (same URL in multiple table/columns = multiple occurrences)
  const urlChecks = result.urlChecks || {};
  let totalOccurrences = 0;
  let urlOk = 0;
  let urlBroken = 0;
  let urlCors = 0;
  for (const [url, sources] of Object.entries(result.externalUrls)) {
    const count = sources.length;
    totalOccurrences += count;
    const check = urlChecks[url];
    if (check) {
      if (check.result === 'ok') urlOk += count;
      else if (check.result === 'broken') urlBroken += count;
      else if (check.result === 'unverifiable') urlCors += count;
    }
  }
  const orphanPct =
    result.totalSize > 0 ? ((result.orphanSize / result.totalSize) * 100).toFixed(1) : '0';

  return (
    <div style={{ marginBottom: 24, fontSize: 14, lineHeight: 1.8 }}>
      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          {/* Storage breakdown */}
          <tr>
            <td style={{ fontWeight: 600, paddingRight: 12, color: '#333' }}>
              {intl.get('assets.total_assets').d('Total assets in storage')}
            </td>
            <td style={{ fontWeight: 600, paddingRight: 8, textAlign: 'right' }}>
              {result.allFiles.length}
            </td>
            <td style={{ color: '#888' }}>({fmtSize(result.totalSize)})</td>
          </tr>
          <tr>
            <td style={{ paddingLeft: 16, paddingRight: 12, color: '#28a745' }}>
              {intl.get('assets.referenced').d('Referenced in rows')}
            </td>
            <td style={{ paddingRight: 8, textAlign: 'right', color: '#28a745' }}>
              {result.referencedCount}
            </td>
            <td style={{ color: '#888' }}>({fmtSize(result.totalSize - result.orphanSize)})</td>
          </tr>
          <tr>
            <td style={{ paddingLeft: 16, paddingRight: 12, color: '#e6a117' }}>
              {intl.get('assets.orphaned').d('Orphaned (not referenced)')}
            </td>
            <td style={{ paddingRight: 8, textAlign: 'right', color: '#e6a117' }}>
              {result.orphans.length}
            </td>
            <td style={{ color: '#888' }}>
              ({fmtSize(result.orphanSize)} &mdash;{' '}
              {intl.get('assets.pct_of_storage', { pct: orphanPct }).d('{pct}% of storage')})
            </td>
          </tr>

          {/* Spacer */}
          <tr>
            <td colSpan={3} style={{ height: 8 }}></td>
          </tr>

          {/* Row references breakdown */}
          <tr>
            <td style={{ paddingRight: 12, color: '#dc3545' }}>
              {intl.get('assets.missing_refs').d('Missing references')}
            </td>
            <td style={{ paddingRight: 8, textAlign: 'right', color: '#dc3545' }}>
              {result.missingRefs.length}
            </td>
            <td style={{ color: '#888' }}>
              {intl.get('assets.missing_refs_desc').d('path(s) in rows pointing to deleted files')}
            </td>
          </tr>
          <tr>
            <td style={{ paddingRight: 12, color: '#6c757d' }}>
              {intl.get('assets.external_urls').d('External URLs')}
            </td>
            <td style={{ paddingRight: 8, textAlign: 'right', color: '#6c757d' }}>
              {totalOccurrences}
            </td>
            <td style={{ color: '#888' }}>
              {totalOccurrences > 0 && Object.keys(urlChecks).length > 0 ? (
                <span style={{ fontSize: 13 }}>
                  {urlOk > 0 && (
                    <span style={{ color: '#28a745' }}>
                      {intl.get('assets.url_ok', { count: urlOk }).d('{count} OK')}
                    </span>
                  )}
                  {urlOk > 0 && (urlBroken > 0 || urlCors > 0) && ' · '}
                  {urlBroken > 0 && (
                    <span style={{ color: '#dc3545' }}>
                      {intl.get('assets.url_broken', { count: urlBroken }).d('{count} broken')}
                    </span>
                  )}
                  {urlBroken > 0 && urlCors > 0 && ' · '}
                  {urlCors > 0 && (
                    <span style={{ color: '#e6a117' }}>
                      {intl
                        .get('assets.url_unverifiable', { count: urlCors })
                        .d('{count} unverifiable')}
                    </span>
                  )}
                </span>
              ) : totalOccurrences > 0 ? (
                <span style={{ fontSize: 13, color: '#e6a117' }}>
                  {intl.get('assets.url_unverified').d('unverified')}
                </span>
              ) : (
                ''
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

export default SummaryCards;
