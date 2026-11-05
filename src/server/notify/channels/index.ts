// The one place a ChannelConfig becomes a Channel.

import type { ChannelConfig } from '../../config.ts'
import type { Channel } from '../types.ts'
import type { ChannelDeps } from './common.ts'
import { createEmailChannel } from './email.ts'
import { createFileChannel } from './file.ts'
import { createNtfyChannel } from './ntfy.ts'
import { createSmsChannel } from './sms.ts'
import { createWebhookChannel } from './webhook.ts'
import { createWebPushChannel } from './webpush.ts'

export type { ChannelDeps } from './common.ts'
export type { PushSub, PushSubscriptionStore } from './webpush.ts'

export function createChannel(cfg: ChannelConfig, deps: ChannelDeps): Channel {
  switch (cfg.type) {
    case 'ntfy':
      return createNtfyChannel(cfg, deps)
    case 'webpush':
      return createWebPushChannel(cfg, deps)
    case 'sms':
      return createSmsChannel(cfg, deps)
    case 'email':
      return createEmailChannel(cfg, deps)
    case 'webhook':
      return createWebhookChannel(cfg, deps)
    case 'file':
      return createFileChannel(cfg, deps)
    default:
      throw new Error(`unknown channel type ${(cfg as { type: string }).type}`)
  }
}
