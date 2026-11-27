import { useState } from 'react'
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Select,
} from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import type {
  McpTransport,
  NewResource,
  Resource,
  ResourceKind,
} from '@agentweave/protocol'
import {
  decodeFile,
  encodeFile,
  errorMessage,
  request,
  resourceKey,
} from './api'
import { KindIcon } from './shared'
import { resourceKinds } from './shared-helpers'

function fileEntries(resource: Resource | null) {
  return Object.entries(resource?.files ?? {}).sort(([first], [second]) => {
    if (first === 'SKILL.md') return -1
    if (second === 'SKILL.md') return 1
    return first.localeCompare(second)
  })
}

function parseConfig(text: string): Record<string, unknown> {
  const config: unknown = JSON.parse(text)
  if (!config || Array.isArray(config) || typeof config !== 'object')
    throw new Error('MCP 配置应为 JSON 对象。')
  return config as Record<string, unknown>
}

type ResourceFields = {
  name: string
  tags?: string[]
  text: string
  description: string
  transport: McpTransport
  command: string
  url: string
  args?: string
  env?: string
  headers?: string
}

function stringFields(text?: string) {
  if (!text?.trim()) return undefined
  const config = parseConfig(text)
  if (Object.values(config).some((value) => typeof value !== 'string'))
    throw new Error('请填写字符串键值对。')
  return config as Record<string, string>
}

function newResourceInput(
  kind: ResourceKind,
  fields: ResourceFields,
): NewResource {
  const {
    name,
    tags,
    description,
    text,
    transport,
    command,
    url,
    args,
    env,
    headers,
  } = fields
  const base = { id: name.trim(), tags }
  if (kind === 'skill') return { ...base, kind, description, text }
  if (kind === 'instructions') return { ...base, kind, text }
  if (kind !== 'mcp') throw new Error('请选择可新建的资源类型。')
  return transport === 'stdio'
    ? {
        ...base,
        kind,
        transport,
        command,
        args: args ? args.replace(/\r?\n$/, '').split(/\r?\n/) : undefined,
        env: stringFields(env),
      }
    : { ...base, kind, transport, url, headers: stringFields(headers) }
}

export function ResourceDrawer({
  resource,
  kind,
  revision,
  onClose,
  onChanged,
  onPreview,
}: {
  resource: Resource | null
  kind: ResourceKind
  revision?: string
  onClose: () => void
  onChanged: () => void | Promise<void>
  onPreview: (resource: Resource, plugin?: Resource) => void
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm<ResourceFields>()
  const transport = Form.useWatch('transport', form) ?? 'stdio'
  const [files, setFiles] = useState<Record<string, string>>(
    resource?.files ?? {},
  )
  const [selectedFile, setSelectedFile] = useState(
    fileEntries(resource)[0]?.[0],
  )
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const newSkill = !resource && kind === 'skill'
  const newMcp = !resource && kind === 'mcp'
  const localMcp = transport === 'stdio'
  const editableText =
    newSkill || kind === 'instructions' || (kind === 'mcp' && !!resource)
  const selectedText = selectedFile ? decodeFile(files[selectedFile]) : null

  async function save(fields: ResourceFields) {
    setSaving(true)
    try {
      if (!resource) {
        await request('create-resource', newResourceInput(kind, fields))
      } else {
        const { name, tags, text } = fields
        const updated = { ...resource, name: name.trim(), tags }
        if (kind === 'instructions') updated.text = text
        if (kind === 'mcp') updated.config = parseConfig(text)
        if (kind === 'skill') updated.files = files
        await request('save-resource', {
          resource: updated,
          replace: true,
          revision,
        })
      }
      message.success('已保存到中央仓库')
      onClose()
      await onChanged()
    } catch (error) {
      message.error(errorMessage(error))
      // 刷新列表供重新打开时使用，抽屉保留当前草稿和打开时的版本。
      if (resource) await onChanged()
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!resource) return
    setRemoving(true)
    try {
      await request('delete-resource', { key: resourceKey(resource) })
      message.success('已从中央仓库删除')
      onClose()
      await onChanged()
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="min(640px, 100vw)"
      closable={!saving && !removing}
      mask={{ closable: !saving && !removing }}
      keyboard={!saving && !removing}
      title={
        resource?.name ??
        (kind === 'instructions'
          ? '新建全局指令'
          : `新建 ${resourceKinds[kind].name}`)
      }
      footer={
        <div className="flex gap-2 justify-between items-center flex-wrap">
          <div>
            {resource && (
              <Popconfirm
                title="从中央仓库删除此资源？"
                description="下次同步时可预览需要清理的 Agent 副本。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={remove}
              >
                <Button danger loading={removing}>
                  删除
                </Button>
              </Popconfirm>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {resource && (
              <Button
                onClick={() => onPreview(resource)}
                icon={<SyncOutlined />}
              >
                分发
              </Button>
            )}
            <Button
              type="primary"
              loading={saving}
              disabled={removing}
              onClick={form.submit}
            >
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-0">
        <Form
          form={form}
          name="resource"
          layout="vertical"
          requiredMark={false}
          disabled={saving || removing}
          initialValues={{
            name: resource?.name,
            tags: resource?.tags,
            text:
              kind === 'mcp' && resource
                ? JSON.stringify(resource.config, null, 2)
                : resource?.text,
            transport: 'stdio',
          }}
          onFinish={save}
        >
          <Form.Item
            name="name"
            label={newSkill ? 'Skill 标识' : '名称'}
            rules={[
              { required: true, whitespace: true, message: '请填写资源名称。' },
            ]}
          >
            <Input
              maxLength={newSkill ? 64 : undefined}
              placeholder={newSkill ? '例如 code-review' : undefined}
            />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="输入标签后按回车" />
          </Form.Item>
          {newSkill && (
            <Form.Item
              name="description"
              label="描述"
              rules={[
                {
                  required: true,
                  whitespace: true,
                  message: '请填写 Skill 描述。',
                },
              ]}
            >
              <Input.TextArea
                rows={3}
                maxLength={1024}
                placeholder="这个 Skill 做什么，什么时候使用"
              />
            </Form.Item>
          )}
          {newMcp && (
            <>
              <Form.Item name="transport" label="连接方式">
                <Select<McpTransport>
                  virtual={false}
                  options={[
                    { label: '本地命令（stdio）', value: 'stdio' },
                    {
                      label: '远程地址（Streamable HTTP）',
                      value: 'streamable-http',
                    },
                    { label: '远程地址（旧版 SSE）', value: 'sse' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                key={localMcp ? 'command' : 'url'}
                name={localMcp ? 'command' : 'url'}
                label={localMcp ? '启动命令' : '服务 URL'}
                rules={[
                  {
                    required: true,
                    whitespace: true,
                    message: localMcp ? '请填写启动命令。' : '请填写服务 URL。',
                  },
                ]}
              >
                <Input
                  placeholder={
                    localMcp ? '例如 npx' : 'https://example.com/mcp'
                  }
                />
              </Form.Item>
              {localMcp && (
                <Form.Item name="args" label="启动参数（每行一个）">
                  <Input.TextArea rows={3} />
                </Form.Item>
              )}
              <Form.Item
                key={localMcp ? 'env' : 'headers'}
                name={localMcp ? 'env' : 'headers'}
                label={
                  localMcp ? '环境变量（JSON，可选）' : '请求头（JSON，可选）'
                }
                rules={[
                  {
                    async validator(_, value?: string) {
                      stringFields(value)
                    },
                  },
                ]}
              >
                <Input.TextArea
                  className="editor-text"
                  rows={3}
                  spellCheck={false}
                />
              </Form.Item>
            </>
          )}
          {editableText && (
            <Form.Item
              name="text"
              label={
                newSkill
                  ? 'Skill 正文（Markdown）'
                  : kind === 'mcp'
                    ? 'MCP 配置（JSON）'
                    : '指令内容（Markdown）'
              }
              rules={
                resource
                  ? undefined
                  : [
                      {
                        required: true,
                        whitespace: true,
                        message: '请填写正文。',
                      },
                    ]
              }
            >
              <Input.TextArea
                rows={12}
                className="editor-text"
                spellCheck={false}
              />
            </Form.Item>
          )}
        </Form>
        {selectedFile && (
          <Form layout="vertical" component="div">
            <Form.Item label="文件" htmlFor="resource-file">
              <Select
                id="resource-file"
                value={selectedFile}
                options={fileEntries(resource).map(([path]) => ({
                  label: path,
                  value: path,
                }))}
                onChange={setSelectedFile}
              />
            </Form.Item>
            {selectedText === null ? (
              <Alert type="info" title="此文件为二进制格式" />
            ) : (
              <Input.TextArea
                aria-label={selectedFile}
                rows={12}
                className="editor-text"
                value={selectedText}
                readOnly={kind === 'plugin'}
                onChange={(event) =>
                  setFiles({
                    ...files,
                    [selectedFile]: encodeFile(event.target.value),
                  })
                }
                spellCheck={false}
              />
            )}
          </Form>
        )}
        {!!resource?.components?.length && (
          <div>
            <h3 className="m-0 mb-2 text-base font-semibold">插件资源</h3>
            <div className="selection-list">
              {resource.components.map((component) => (
                <div className="selection-row" key={resourceKey(component)}>
                  <KindIcon kind={component.kind} />
                  <strong className="flex-1 wrap-anywhere">
                    {component.name}
                  </strong>
                  <Button
                    icon={<SyncOutlined />}
                    onClick={() => onPreview(component, resource)}
                  >
                    单独分发
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Drawer>
  )
}
