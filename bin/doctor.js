#!/usr/bin/env node
/**
 * bin/doctor.js — Nearcade System Doctor CLI
 *
 * Runs comprehensive preflight diagnostic checks on the host environment:
 * input device permissions, display server & portals, audio daemons,
 * hardware encoders, network interfaces, and system resource limits.
 *
 * Usage:
 *   node bin/doctor.js
 *   node bin/doctor.js --json
 *   npm run doctor
 *
 * License: MIT
 */

'use strict';

const systemDoctor = require('../src/scripts/core/system-doctor.js');

const isJson = process.argv.includes('--json');

async function main() {
  if (!isJson) {
    console.log('\n============================================================');
    console.log('            Nearcade System Doctor Diagnostic Suite          ');
    console.log('============================================================\n');
  }

  const report = await systemDoctor.runAllChecks();

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.hasFatal ? 1 : 0);
  }

  console.log(`Platform : ${report.platform} (${report.arch}) - Kernel ${report.release}`);
  console.log(`Duration : ${report.durationMs}ms\n`);

  const subsystems = {
    input: 'Input Subsystem & Virtual Devices',
    display: 'Display Server & Screen Capture',
    audio: 'Audio Infrastructure & Loopback',
    encoder: 'Hardware Video Encoders & GPU',
    network: 'Network Interfaces & Connectivity',
    system: 'System Limits & Power Management'
  };

  const grouped = {};
  for (const check of report.checks) {
    const sub = check.subsystem || 'system';
    if (!grouped[sub]) grouped[sub] = [];
    grouped[sub].push(check);
  }

  for (const [subKey, title] of Object.entries(subsystems)) {
    const items = grouped[subKey];
    if (!items || items.length === 0) continue;

    console.log(`[${title.toUpperCase()}]`);
    for (const item of items) {
      let mark = '  [OK]  ';
      if (item.status === 'warn') mark = '  [WARN]';
      if (item.status === 'fail') mark = '  [FAIL]';
      if (item.status === 'info') mark = '  [INFO]';

      console.log(`${mark} ${item.name}: ${item.message}`);
      if (item.remediation) {
        console.log(`         Remediation: ${item.remediation}`);
      }
    }
    console.log('');
  }

  console.log('------------------------------------------------------------');
  console.log(`Summary: ${report.stats.ok} passed, ${report.stats.warn} warning(s), ${report.stats.fail} failure(s).`);

  if (report.hasFatal) {
    console.log('\nStatus: CRITICAL ISSUES DETECTED. See remediation steps above.');
    process.exit(1);
  } else if (report.stats.warn > 0) {
    console.log('\nStatus: READY WITH WARNINGS. Streaming will work with fallbacks.');
    process.exit(0);
  } else {
    console.log('\nStatus: ALL CHECKS PASSED. Host system is fully optimized for streaming.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('\nDoctor CLI runtime error:', err);
  process.exit(1);
});
