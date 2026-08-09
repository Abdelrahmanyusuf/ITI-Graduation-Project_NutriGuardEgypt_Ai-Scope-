/* global console, process */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files=execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],{encoding:"utf8"}).split("\0").filter(Boolean);
const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b(?:sk|rk)-[A-Za-z0-9_-]{24,}\b/,/(?:api[_-]?key|password|secret)\s*[:=]\s*["'](?!\[?REDACTED|example|test|change-me)[^"']{12,}["']/iu];
const findings=[];
for(const file of files){if(/(?:package-lock\.json|data\/raw\/|\.png$|\.pdf$)/u.test(file))continue;let text;try{text=readFileSync(file,"utf8");}catch{continue;}for(const [index,line] of text.split(/\r?\n/u).entries()){if(line.includes("secret-scan: allow-test"))continue;for(const pattern of patterns)if(pattern.test(line))findings.push(`${file}:${index+1}: ${pattern.source}`);}}
if(findings.length){console.error(`Potential secrets found:\n${findings.join("\n")}`);process.exit(1);}console.log(`Secret scan passed (${files.length} tracked files inspected).`);
