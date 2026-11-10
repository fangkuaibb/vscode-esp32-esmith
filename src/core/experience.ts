import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Experience 引擎：把“疑难问题的修复经验”沉淀到项目内，供后续闭环参考。
 * 只记录经验，不自动修改代码；源码、密钥等敏感内容不应写入。
 */

export interface ExperienceSkill {
  id: string;
  trigger: string;
  fix: string;
  lesson: string;
  scope?: string;
  createdAt: string;
  hits: number;
}

export interface ExperienceQueryHit extends ExperienceSkill {
  score: number;
}

export interface ExperienceQueryResult {
  success: boolean;
  query: string;
  skills: ExperienceQueryHit[];
  total: number;
}

export interface RecordExperienceInput {
  trigger: string;
  fix: string;
  lesson: string;
  scope?: string;
}

export interface ExperienceStats {
  updatedAt: string;
  runs: number;
  success: number;
  failure: number;
  stages: Record<string, { success: number; failure: number }>;
  lastFailures: Array<{ ts: string; stage: string; message: string }>;
}

const EXPERIENCE_DIR = path.join('.esmith', 'experience');
const SKILLS_DIR = 'skills';
const STATS_FILE = 'stats.json';
const MAX_FAILURES = 20;
const MAX_MESSAGE_LENGTH = 500;

export function experienceRoot(projectRoot: string): string {
  return path.join(projectRoot, EXPERIENCE_DIR);
}

function skillsRoot(projectRoot: string): string {
  return path.join(experienceRoot(projectRoot), SKILLS_DIR);
}

function statsPath(projectRoot: string): string {
  return path.join(experienceRoot(projectRoot), STATS_FILE);
}

function ensureDirs(projectRoot: string): void {
  fs.mkdirSync(path.join(experienceRoot(projectRoot), SKILLS_DIR), { recursive: true });
}

function clamp(value: string, maxLength = MAX_MESSAGE_LENGTH): string {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

function tokenize(query: string): string[] {
  const matches = String(query ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!matches) {
    return [];
  }
  return Array.from(new Set(matches.filter((token) => token.length >= 2)));
}

export function recordExperience(
  projectRoot: string,
  input: RecordExperienceInput
): { success: boolean; id: string; path: string } {
  const trigger = clamp(input.trigger);
  const fix = clamp(input.fix);
  const lesson = clamp(input.lesson);
  if (!trigger || !fix) {
    throw new Error('trigger 与 fix 不能为空');
  }

  ensureDirs(projectRoot);
  const id = createHash('sha1')
    .update(`${trigger}|${fix}`)
    .digest('hex')
    .slice(0, 12);
  const filePath = path.join(skillsRoot(projectRoot), `${id}.json`);

  let hits = 1;
  if (fs.existsSync(filePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ExperienceSkill;
      hits = Number(existing.hits ?? 0) + 1;
    } catch {
      hits = 1;
    }
  }

  const skill: ExperienceSkill = {
    id,
    trigger,
    fix,
    lesson: lesson || fix,
    scope: input.scope ? clamp(input.scope, 80) : undefined,
    createdAt: new Date().toISOString(),
    hits,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(skill, null, 2)}\n`, 'utf8');
  return { success: true, id, path: filePath };
}

function readSkills(projectRoot: string): ExperienceSkill[] {
  const directory = skillsRoot(projectRoot);
  if (!fs.existsSync(directory)) {
    return [];
  }
  const result: ExperienceSkill[] = [];
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    try {
      const skill = JSON.parse(
        fs.readFileSync(path.join(directory, entry), 'utf8')
      ) as ExperienceSkill;
      if (skill && skill.trigger && skill.fix) {
        result.push({
          ...skill,
          lesson: skill.lesson ?? skill.fix,
          hits: Number(skill.hits ?? 0),
        });
      }
    } catch {
      // 忽略损坏的经验文件
    }
  }
  return result;
}

export function queryExperience(
  projectRoot: string,
  query: string,
  limit = 5
): ExperienceQueryResult {
  const normalized = clamp(query, 200).toLowerCase();
  const tokens = tokenize(query);
  const scored: ExperienceQueryHit[] = [];

  for (const skill of readSkills(projectRoot)) {
    const text = `${skill.trigger} ${skill.fix} ${skill.lesson} ${skill.scope ?? ''}`.toLowerCase();
    let score = 0;
    if (normalized && text.includes(normalized)) {
      score += 10;
    }
    for (const token of tokens) {
      if (text.includes(token)) {
        score += 1;
      }
    }
    if (score > 0) {
      scored.push({ ...skill, score: score + Math.min(skill.hits, 5) * 0.1 });
    }
  }

  scored.sort((left, right) => right.score - left.score || right.hits - left.hits);
  return {
    success: true,
    query: normalized,
    skills: scored.slice(0, Math.max(1, limit)),
    total: scored.length,
  };
}

export function experienceHints(projectRoot: string, query: string, limit = 3): string[] {
  return queryExperience(projectRoot, query, limit).skills.map(
    (skill) => `${skill.trigger} → ${skill.fix}${skill.lesson ? `（${skill.lesson}）` : ''}`
  );
}

function defaultStats(): ExperienceStats {
  return {
    updatedAt: new Date().toISOString(),
    runs: 0,
    success: 0,
    failure: 0,
    stages: {},
    lastFailures: [],
  };
}

export function readStats(projectRoot: string): ExperienceStats {
  try {
    const parsed = JSON.parse(fs.readFileSync(statsPath(projectRoot), 'utf8')) as ExperienceStats;
    return {
      ...defaultStats(),
      ...parsed,
      stages: parsed.stages ?? {},
      lastFailures: Array.isArray(parsed.lastFailures) ? parsed.lastFailures : [],
    };
  } catch {
    return defaultStats();
  }
}

export function updateRunStats(
  projectRoot: string,
  result: { success: boolean; stage: string; message: string }
): ExperienceStats {
  ensureDirs(projectRoot);
  const stats = readStats(projectRoot);
  stats.runs += 1;
  if (result.success) {
    stats.success += 1;
  } else {
    stats.failure += 1;
    stats.lastFailures.push({
      ts: new Date().toISOString(),
      stage: result.stage,
      message: clamp(result.message),
    });
    stats.lastFailures = stats.lastFailures.slice(-MAX_FAILURES);
  }
  const stage = stats.stages[result.stage] ?? { success: 0, failure: 0 };
  if (result.success) {
    stage.success += 1;
  } else {
    stage.failure += 1;
  }
  stats.stages[result.stage] = stage;
  stats.updatedAt = new Date().toISOString();
  fs.writeFileSync(statsPath(projectRoot), `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
  return stats;
}
