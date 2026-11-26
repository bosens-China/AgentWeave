import { installedTarget } from './installed.js'
import { errorCode } from '../errors.js'
import { mcpTransports } from './mcp-format.js'
import type { McpLocation, NativeTarget, TargetConfig } from './types.js'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const UNIVERSAL = '.agents/skills'

function envDirectory(home: string, variable: string, fallback: string) {
  const configured =
    home === resolve(homedir()) ? process.env[variable] : undefined
  return configured && isAbsolute(configured)
    ? configured
    : resolve(home, fallback)
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
      return false
    throw error
  }
}

function mcp(
  path: string,
  key = 'mcpServers',
  format: McpLocation['format'] = 'jsonc',
  variant = 'standard',
): McpLocation {
  return { path, key, format, variant }
}

export async function resolveTargets({ home = homedir() } = {}): Promise<
  NativeTarget[]
> {
  home = resolve(home)
  const codex = envDirectory(home, 'CODEX_HOME', '.codex')
  const claude = envDirectory(home, 'CLAUDE_CONFIG_DIR', '.claude')
  const pi = envDirectory(home, 'PI_CODING_AGENT_DIR', '.pi/agent')
  const opencode = envDirectory(
    home,
    'OPENCODE_CONFIG_DIR',
    join(envDirectory(home, 'XDG_CONFIG_HOME', '.config'), 'opencode'),
  )
  const kimi = envDirectory(home, 'KIMI_CODE_HOME', '.kimi-code')
  const openclaw = envDirectory(home, 'OPENCLAW_STATE_DIR', '.openclaw')
  const copilot = envDirectory(home, 'COPILOT_HOME', '.copilot')
  const gemini = join(home, '.gemini')
  const antigravity =
    (await exists(join(gemini, 'antigravity/skills'))) &&
    !(await exists(join(gemini, 'config/.migrated'))) &&
    !(await exists(join(gemini, 'config/skills')))
      ? join(gemini, 'antigravity')
      : join(gemini, 'config')
  const windsurf = join(home, '.codeium/windsurf')
  const cursor = join(home, '.cursor')
  const qwen = join(home, '.qwen')
  const kiro = join(home, '.kiro')
  const clineRoot = envDirectory(home, 'CLINE_DIR', '.cline')
  const clineData = envDirectory(
    home,
    'CLINE_DATA_DIR',
    join(clineRoot, 'data'),
  )
  const clineCurrentMcp = join(clineData, 'settings/cline_mcp_settings.json')
  const codeUser =
    process.platform === 'darwin'
      ? join(home, 'Library/Application Support/Code/User')
      : process.platform === 'win32'
        ? join(envDirectory(home, 'APPDATA', 'AppData/Roaming'), 'Code/User')
        : join(envDirectory(home, 'XDG_CONFIG_HOME', '.config'), 'Code/User')
  const clineLegacyMcp = join(
    codeUser,
    'globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
  )
  const clineMcp = envDirectory(
    home,
    'CLINE_MCP_SETTINGS_PATH',
    !(await exists(clineCurrentMcp)) &&
      !(await exists(clineData)) &&
      (await exists(clineLegacyMcp))
      ? clineLegacyMcp
      : clineCurrentMcp,
  )
  const opencodeConfig = (await exists(join(opencode, 'opencode.jsonc')))
    ? 'opencode.jsonc'
    : 'opencode.json'
  const universal = join(home, UNIVERSAL)
  const configs: TargetConfig[] = [
    {
      id: 'codex',
      name: 'Codex',
      root: codex,
      skills: universal,
      instructions: join(codex, 'AGENTS.md'),
      mcp: mcp(join(codex, 'config.toml'), 'mcp_servers', 'toml', 'codex'),
      plugin: { kind: 'codex', root: codex },
    },
    {
      id: 'claude',
      name: 'Claude Code',
      root: claude,
      instructions: join(claude, 'CLAUDE.md'),
      mcp: mcp(
        claude === join(home, '.claude')
          ? join(home, '.claude.json')
          : join(claude, '.claude.json'),
        'mcpServers',
        'jsonc',
        'claude',
      ),
      plugin: { kind: 'claude', root: claude },
    },
    {
      id: 'pi',
      name: 'Pi',
      root: pi,
      sharedSkills: [universal],
      instructions: join(pi, 'AGENTS.md'),
      flatSkills: true,
      mcp: mcp(join(pi, 'mcp.json'), 'mcpServers', 'jsonc', 'pi'),
      plugin: { kind: 'pi', root: pi },
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      root: opencode,
      sharedSkills: [universal, join(claude, 'skills')],
      flatSkills: true,
      instructions: join(opencode, 'AGENTS.md'),
      mcp: mcp(join(opencode, opencodeConfig), 'mcp', 'jsonc', 'opencode'),
    },
    {
      id: 'cursor',
      name: 'Cursor',
      root: cursor,
      sharedSkills: [universal, join(claude, 'skills'), join(codex, 'skills')],
      mcp: mcp(join(cursor, 'mcp.json')),
      plugin: { kind: 'cursor', root: join(cursor, 'plugins/local') },
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      root: antigravity,
      // Antigravity Desktop and Gemini CLI read the same user instructions.
      instructions: join(gemini, 'GEMINI.md'),
      mcp: mcp(
        join(antigravity, 'mcp_config.json'),
        'mcpServers',
        'jsonc',
        'antigravity',
      ),
      plugin: { kind: 'antigravity', root: join(antigravity, 'plugins') },
    },
    {
      id: 'cline',
      name: 'Cline',
      root: clineRoot,
      sharedSkills: [universal],
      instructions: join(home, '.agents/AGENTS.md'),
      mcp: mcp(clineMcp, 'mcpServers', 'jsonc', 'cline'),
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      root: windsurf,
      instructions: join(windsurf, 'memories/global_rules.md'),
      instructionsLimit: 6000,
      mcp: mcp(
        join(windsurf, 'mcp_config.json'),
        'mcpServers',
        'jsonc',
        'windsurf',
      ),
    },
    {
      id: 'qwen',
      name: 'Qwen Code',
      root: qwen,
      instructions: join(qwen, 'QWEN.md'),
      mcp: mcp(join(qwen, 'settings.json'), 'mcpServers', 'jsonc', 'qwen'),
    },
    {
      id: 'openclaw',
      name: 'OpenClaw',
      root: openclaw,
      sharedSkills: openclaw === join(home, '.openclaw') ? [universal] : [],
    },
    {
      id: 'kiro',
      name: 'Kiro',
      root: kiro,
      instructions: join(kiro, 'steering/AGENTS.md'),
      mcp: mcp(join(kiro, 'settings/mcp.json'), 'mcpServers', 'jsonc', 'kiro'),
    },
    {
      id: 'copilot',
      name: 'GitHub Copilot',
      root: copilot,
      instructions: join(copilot, 'copilot-instructions.md'),
      mcp: mcp(
        join(copilot, 'mcp-config.json'),
        'mcpServers',
        'jsonc',
        'copilot',
      ),
    },
    {
      id: 'kimi-code',
      name: 'Kimi Code',
      root: kimi,
      sharedSkills: [universal],
      flatSkills: true,
      instructions: join(kimi, 'AGENTS.md'),
      mcp: mcp(join(kimi, 'mcp.json'), 'mcpServers', 'jsonc', 'kimi'),
    },
  ]
  return Promise.all(
    configs.map(async (target) => {
      const path = target.skills ?? join(target.root, 'skills')
      const detected = await installedTarget(target.id, home)
      return {
        ...target,
        home,
        skills: path,
        detected,
        sharedSkills: target.sharedSkills ?? [],
        mcpTransports: target.mcp && mcpTransports(target.mcp.variant),
        instructionsPaths: target.instructions
          ? target.id === 'codex'
            ? [join(target.root, 'AGENTS.override.md'), target.instructions]
            : [target.instructions]
          : undefined,
        kinds: (['skill', 'mcp', 'instructions', 'plugin'] as const).filter(
          (kind) => kind === 'skill' || target[kind],
        ),
      }
    }),
  )
}

export function targetFor(targets: NativeTarget[], id: string) {
  const target = targets.find((candidate) => candidate.id === id)
  if (!target) throw new Error(`未知 Agent：${id}`)
  return target
}
