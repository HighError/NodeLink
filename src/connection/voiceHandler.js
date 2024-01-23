import { debugLog, waitForEvent } from '../utils.js'
import config from '../../config.js'
import constants from '../../constants.js'
import sources from '../sources.js'
import Filters from '../filters.js'

import inputHandler from './inputHandler.js'

import voiceUtils from '../voice/utils.js'

import discordVoice from '@performanc/voice'

global.nodelinkPlayersCount = 0
global.nodelinkPlayingPlayersCount = 0
 
class VoiceConnection {
  constructor(guildId, client) {
    this.connection = null
    this.client = client
    this.cache = {
      url: null,
      protocol: null,
      track: null,
      volume: 100
    }
    this.stateInterval
  
    this.config = {
      guildId,
      track: null,
      volume: 100,
      paused: false,
      filters: {},
      voice: {
        token: null,
        endpoint: null,
        sessionId: null
      }
    }
  }

  _stopTrack() {
    nodelinkPlayingPlayersCount--

    if (this.stateInterval) clearInterval(this.stateInterval)

    this.config.state = {
      time: null,
      position: 0,
      connected: false,
      ping: -1
    }
  }

  _getRealTime() {
    return this.connection.statistics.packetsExpected * 20
  }

  setup() {
    nodelinkPlayersCount++

    this.connection = discordVoice.joinVoiceChannel({ guildId: this.config.guildId, userId: this.client.userId, encryption: config.audio.encryption })
    this.connection.on('speakStart', (userId, ssrc) => inputHandler.handleStartSpeaking(ssrc, userId, this.config.guildId))

    this.connection.on('stateChange', async (oldState, newState) => {
      switch (newState.status) {
        case 'disconnected': {
          if (oldState.status == 'disconnected') return;

          if (newState.code != 4015) {
              debugLog('websocketClosed', 2, { track: this.config.track?.info, exception: constants.VoiceWSCloseCodes[newState.closeCode] })

              this.connection.destroy()
              this._stopTrack()
              this.config = {
                guildId: this.config.guildId,
                track: null,
                volume: 100,
                paused: false,
                filters: {},
                voice: {
                  token: null,
                  endpoint: null,
                  sessionId: null
                }
              }

              this.client.ws.send(JSON.stringify({
                op: 'event',
                type: 'WebSocketClosedEvent',
                guildId: this.config.guildId,
                code: newState.closeCode,
                reason: constants.VoiceWSCloseCodes[newState.closeCode],
                byRemote: true
              }))
          } else {
            /* Should send trackException instead */
          }
          break;
        }
      }
    })

    this.connection.on('playerStateChange', (oldState, newState) => {
      if (newState.status == 'idle' && oldState.status != 'idle') {
        if (newState.reason != 'finished') return;

        this._stopTrack()
        this.cache.url = null

        debugLog('trackEnd', 2, { track: this.config.track.info, reason: 'finished' })

        this.client.ws.send(JSON.stringify({
          op: 'event',
          type: 'TrackEndEvent',
          guildId: this.config.guildId,
          track: this.config.track,
          reason: 'finished'
        }))

        this.config.track = null
      }

      if (oldState.status != 'paused' && newState.status == 'playing') {
        if (newState.reason != 'requested') return;

        this.cache.startedAt = Date.now()

        debugLog('trackStart', 2, { track: this.config.track.info })
        
        nodelinkPlayingPlayersCount++

        if (config.options.playerUpdateInterval) this.stateInterval = setInterval(() => {
          this.client.ws.send(JSON.stringify({
            op: 'playerUpdate',
            guildId: this.config.guildId,
            state: {
              time: Date.now(),
              position: [ 'playing', 'paused' ].includes(this.connection.playerState.status) ? this._getRealTime() : 0,
              connected: this.connection.state.status == 'connected',
              ping: this.connection.ping
            }
          }))
        }, config.options.playerUpdateInterval)

        this.client.ws.send(JSON.stringify({
          op: 'event',
          type: 'TrackStartEvent',
          guildId: this.config.guildId,
          track: this.config.track
    }))
      }
    })

    this.connection.on('error', (error) => {
      this._stopTrack()

      debugLog('trackException', 2, { track: this.config.track?.info, exception: error.message })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: this.config.track,
        exception: {
          message: error.message,
          severity: 'fault',
          cause: `${error.name}: ${error.message}`
        }
      }))

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: this.config.track,
        reason: 'loadFailed'
      }))

      this.config.track = null
    })
  }

  updateVoice(buffer) {
    this.config.voice = buffer

    this.connection.voiceStateUpdate({ guild_id: this.config.guildId, user_id: this.client.userId, session_id: buffer.sessionId })
    this.connection.voiceServerUpdate({ user_id: this.client.userId, token: buffer.token, guild_id: this.config.guildId, endpoint: buffer.endpoint })

    if (!this.connection.ws) this.connection.connect()
  }

  destroy() {
    if (this.connection) this.connection.destroy()

    this._stopTrack()

    this.client.players.delete(this.config.guildId)
  }

  async getResource(decodedTrack, urlInfo) {
    return new Promise(async (resolve) => {
      const streamInfo = await sources.getTrackStream(decodedTrack, urlInfo.url, urlInfo.protocol, urlInfo.additionalData)

      if (streamInfo.exception) return resolve(streamInfo)

      this.cache.url = urlInfo.url

      resolve({ stream: voiceUtils.createAudioResource(streamInfo.stream, urlInfo.format) })
    })
  }

  async play(track, decodedTrack, noReplace) {
    if (noReplace && this.config.track) return this.config

    const oldTrack = this.config.track

    const urlInfo = await sources.getTrackURL(decodedTrack)

    if (urlInfo.exception) {
      this.config.track = null
      this.cache.url = null

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: {
          encoded: track,
          info: decodedTrack
        },
        exception: urlInfo.exception
      }))

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: {
          encoded: track,
          info: decodedTrack,
          userData: this.config.track.userData
        },
        reason: 'loadFailed'
      }))

      return this.config
    }

    if (oldTrack?.encoded) {
      debugLog('trackEnd', 2, { track: decodedTrack, reason: 'replaced' })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: oldTrack,
        reason: 'replaced'
      }))
    }

    let resource = null

    if (Object.keys(this.config.filters).length > 0) {
      const filter = new Filters()

      this.config.filters = filter.configure(this.config.filters)

      resource = await filter.getResource(this.config.guildId, decodedTrack, urlInfo.protocol, urlInfo.url, null, null, this.cache.ffmpeg, urlInfo.additionalData)  

      if (oldTrack) this._stopTrack()
    } else {
      this.cache.url = urlInfo.url
      resource = await this.getResource(decodedTrack, urlInfo)

      if (oldTrack) this._stopTrack()
    }
  
    if (resource.exception) {
      this.config.track = null
      this.config.filters = []
      this.cache.url = null

      debugLog('trackException', 2, { track: decodedTrack, exception: resource.exception.message })

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: {
          encoded: track,
          info: decodedTrack,
          userData: this.config.track.userData
        },
        exception: resource.exception
      }))

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: {
          encoded: track,
          info: decodedTrack,
          userData: this.config.track.userData
        },
        reason: 'loadFailed'
      }))

      return this.config
    }

    this.config.track = { encoded: track, info: decodedTrack }

    if (this.cache.volume != 100) {
      resource.stream.setVolume(this.cache.volume / 100)
     
      this.config.volume = this.cache.volume
    }
  
    if (!this.connection.udpInfo?.secretKey)
      await waitForEvent(this.connection, 'stateChange', (_oldState, newState) => newState.status == 'connected', config.options.threshold || undefined)
    
    this.connection.play(resource.stream)

    this.cache.protocol = urlInfo.protocol

    return this.config
  }

  stop() {
    if (!this.config.track) return this.config

    debugLog('trackEnd', 2, { track: this.config.track.info, reason: 'stopped' })

    this.client.ws.send(JSON.stringify({
      op: 'event',
      type: 'TrackEndEvent',
      guildId: this.config.guildId,
      track: this.config.track,
      reason: 'stopped'
    }))

    if (this.connection.audioStream) this.connection.stop()
    this.config.track = null
    this.config.filters = []
    this.cache.url = null

    this._stopTrack()
  }

  volume(volume) {
    if (!this.connection.audioStream) {
      this.cache.volume = volume

      return this.config
    }

    this.connection.audioStream.volume.setVolume(volume / 100)

    this.config.volume = volume

    return this.config
  }

  pause(pause) {
    if (pause) this.connection.pause()
    else this.connection.unpause()

    this.config.paused = pause
    
    return this.config
  }

  async filters(filters) {
    if (this.connection.playerState.status != 'playing' || !config.filters.enabled) return this.config

    const filter = new Filters()

    this.config.filters = filter.configure(filters)

    if (!this.config.track) return this.config

    const protocol = this.cache.protocol
    const resource = await filter.getResource(this.config.guildId, this.config.track.info, protocol, this.cache.url, this._getRealTime(), filters.endTime, this.cache.ffmpeg, null)

    if (resource.exception) {
      this.config.track = null
      this.config.filters = []
      this.cache.url = null

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackExceptionEvent',
        guildId: this.config.guildId,
        track: this.config.track,
        exception: resource.exception
      }))

      this.client.ws.send(JSON.stringify({
        op: 'event',
        type: 'TrackEndEvent',
        guildId: this.config.guildId,
        track: this.config.track.info,
        reason: 'loadFailed'
      }))

      return this.config
    }

    if (!this.connection.udpInfo?.secretKey)
      await waitForEvent(this.connection, 'stateChange', (_oldState, newState) => newState.status == 'connected', config.options.threshold || undefined)
    
    this.connection.play(resource.stream)

    return this.config
  }
}

export default VoiceConnection
