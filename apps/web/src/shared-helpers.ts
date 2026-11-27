import { useCallback } from 'react'
import type { ResourceKind } from '@agentweave/protocol'
import { App } from 'antd'
import {
  ApiOutlined,
  AppstoreOutlined,
  FileTextOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'

export const resourceKinds = {
  skill: {
    label: 'Skills',
    name: 'Skill',
    icon: ThunderboltOutlined,
    color: '#1677ff',
    bg: '#e6f4ff',
    tag: 'blue',
  },
  mcp: {
    label: 'MCP',
    name: 'MCP',
    icon: ApiOutlined,
    color: '#722ed1',
    bg: '#f9f0ff',
    tag: 'purple',
  },
  instructions: {
    label: '全局指令',
    name: '全局指令',
    icon: FileTextOutlined,
    color: '#d48806',
    bg: '#fffbe6',
    tag: 'gold',
  },
  plugin: {
    label: '插件',
    name: '插件',
    icon: AppstoreOutlined,
    color: '#13a8a8',
    bg: '#e6fffb',
    tag: 'cyan',
  },
}

export const kindOptions = (Object.keys(resourceKinds) as ResourceKind[]).map(
  (value) => ({ label: resourceKinds[value].label, value }),
)

export function useConfirmDiscard() {
  const { modal } = App.useApp()
  return useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        modal.confirm({
          title: '放弃未保存的修改？',
          content: '当前修改尚未保存，离开后将丢失。',
          okText: '放弃修改',
          okButtonProps: { danger: true },
          cancelText: '继续编辑',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      }),
    [modal],
  )
}
