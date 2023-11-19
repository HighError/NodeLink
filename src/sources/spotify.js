import https from 'node:https'
import zlib from 'node:zlib'

import config from '../../config.js'
import { debugLog, makeRequest, encodeTrack, sleep, http1makeRequest } from '../utils.js'
import searchWithDefault from './default.js'

let playerInfo = {}

async function init() {
  debugLog('spotify', 5, { type: 1, message: 'Fetching token...' })

  const token = await makeRequest('https://open.spotify.com/get_access_token', {
    method: 'GET'
  })

  if (typeof token != 'object') {
    debugLog('spotify', 5, { type: 2, message: 'Failed to fetch Spotify token.' })

    return;
  }

  const data = await http1makeRequest('https://clienttoken.spotify.com/v1/clienttoken', {
    body: {
      client_data: {
        client_version: '1.2.9.2269.g2fe25d39',
        client_id: 'd8a5ed958d274c2e8ee717e6a4b0971d',
        js_sdk_data: {
          device_brand: 'unknown',
          device_model: 'unknown',
          os: 'linux',
          os_version: 'unknown',
          device_id: '0c5f7c36-855e-4d0a-a661-1a79958ee6de',
          device_type: 'computer'
        }
      }
    },
    headers: {
      'Accept': 'application/json'
    },
    method: 'POST',
    disableBodyCompression: true
  })

  if (typeof data != 'object') {
    debugLog('spotify', 5, { type: 2, message: 'Failed to fetch client token.' })

    return;
  }

  if (data.response_type != 'RESPONSE_GRANTED_TOKEN_RESPONSE') {
    debugLog('spotify', 5, { type: 2, message: 'Failed to fetch client token.' })

    return;
  }

  playerInfo = {
    accessToken: token.accessToken,
    clientToken: data.granted_token.token
  }

  debugLog('spotify', 5, { type: 1, message: 'Successfully fetched token.' })
}

async function search(query) {
  return new Promise(async (resolve) => {
    if (!playerInfo.accessToken) while (1) {
      if (playerInfo.accessToken) break

      sleep(200)
    }

    debugLog('search', 4, { type: 1, sourceName: 'Spotify', query })

    https.get({
      hostname: 'api-partner.spotify.com',
      path: `/pathfinder/v1/query?operationName=searchDesktop&variables=%7B%22searchTerm%22%3A%22${encodeURI(query)}%22%2C%22offset%22%3A0%2C%22limit%22%3A10%2C%22numberOfTopResults%22%3A5%2C%22includeAudiobooks%22%3Atrue%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%221d3a8f81abf4f33f49d1e389ed0956761af669eedb62a050c6c7bce5c66070bb%22%7D%7D`,
      method: 'GET',
      headers: {
        'Host': 'api-partner.spotify.com',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
        'Accept': 'application/json',
        'Accept-Language': 'en',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://open.spotify.com/',
        'authorization': `Bearer ${playerInfo.accessToken}`,
        'app-platform': 'WebPlayer',
        'spotify-app-version': '1.2.9.1649.gd4540f47',
        'content-type': 'application/json;charset=UTF-8',
        'client-token': playerInfo.clientToken,
        'Origin': 'https://open.spotify.com',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      }
    }, (res) => {
      let data = ''

      const compression = zlib.createGunzip()
      res.pipe(compression)
    
      compression.on('data', (chunk) => data += chunk)
    
      compression.on('end', () => {
        data = JSON.parse(data)

        if (data.data.searchV2.tracksV2.totalCount == 0) {
          debugLog('search', 4, { type: 3, sourceName: 'Spotify', query, message: 'No matches found.' })

          return resolve({ loadType: 'empty', data: {} })
        }
          
        const tracks = []
        let index = 0

        if (data.data.searchV2.tracksV2.items.length > config.options.maxResultsLength)
          data.data.searchV2.tracksV2.items = data.data.searchV2.tracksV2.items.splice(0, config.options.maxResultsLength) 

        data.data.searchV2.tracksV2.items.forEach(async (items) => {
          if (items) {
            items = items.item.data

            const search = await searchWithDefault(`${items.name} ${items.artists.items[0].profile.name}`)

            if (search.loadType == 'search') {
              const track = {
                identifier: search.data[0].info.identifier,
                isSeekable: true,
                author: items.artists.items.map((artist) => artist.profile.name).join(', '),
                length: items.duration.totalMilliseconds,
                isStream: false,
                position: 0,
                title: items.name,
                uri: items.uri,
                artworkUrl: search.data[0].info.artworkUrl,
                isrc: items.external_ids.isrc,
                sourceName: 'spotify'
              }

              tracks.push({
                encoded: encodeTrack(track),
                info: track,
                pluginInfo: {}
              })
            }
          }

          if (index == data.data.searchV2.tracksV2.items.length - 1) {
            if (tracks.length == 0) {
              debugLog('search', 4, { type: 3, sourceName: 'Spotify', query, message: 'No matches found.' })

              return resolve({ loadType: 'empty', data: {} })
            }

            const new_tracks = []
            data.data.searchV2.tracksV2.items.forEach((items2, index2) => {
              tracks.forEach((track2, index3) => {
                if (track2.info.title == items2.item.data.name && track2.info.author == items2.item.data.artists.items.map((artist) => artist.profile.name).join(', ')) {
                  track2.info.position = index2
                  new_tracks.push(track2)
                }

                debugLog('search', 4, { type: 2, loadType: 'track', sourceName: 'Spotify', trackLen: new_tracks.length, query })

                if ((index2 == data.data.searchV2.tracksV2.items.length - 1) && (index3 == tracks.length - 1))
                  resolve({
                    loadType: 'search',
                    data: new_tracks
                  })
              })
            })
          }

          index++
        })
      })
    })
  })    
}

async function loadFrom(query, type) {
  return new Promise(async (resolve) => {
    let endpoint

    switch (type[1]) {
      case 'track': {
        endpoint = `/tracks/${type[2]}`
        break
      }
      case 'playlist': {
        endpoint = `/playlists/${type[2]}`
        break
      }
      case 'album': {
        endpoint = `/albums/${type[2]}`
        break
      }
      case 'episode': {
        endpoint = `/episodes/${type[2]}?market=${config.search.sources.spotify.market}`
        break
      }
      case 'show': {
        endpoint = `/shows/${type[2]}?market=${config.search.sources.spotify.market}`
        break
      }
      default: {
        return resolve({ loadType: 'empty', data: {} })
      }
    }

    debugLog('loadtracks', 4, { type: 1, loadType: type[1], sourceName: 'Spotify', query })

    let data = await makeRequest(`https://api.spotify.com/v1${endpoint}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${playerInfo.accessToken}`
      }
    })

    if (data.error) {
      if (data.error.status == 401) {
        setSpotifyToken()

        data = await makeRequest(`https://api.spotify.com/v1${endpoint}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${playerInfo.accessToken}`
          }
        })
      }

      if (data.error.status == 400) {
        debugLog('loadtracks', 4, { type: 3, loadType: type[1], sourceName: 'Spotify', query, message: 'No matches found.' })

        return resolve({ loadType: 'empty', data: {} })
      }

      if (data.error.message == 'Invalid playlist Id') {
        debugLog('loadtracks', 4, { type: 3, loadType: type[1], sourceName: 'Spotify', query, message: 'No matches found.' })

        return resolve({ loadType: 'empty', data: {} })
      }
    
      if (data.error) {
        debugLog('loadtracks', 4, { type: 3, loadType: type[1], sourceName: 'Spotify', query, message: data.error.message })

        return resolve({ loadType: 'error', data: { message: data.error.message, severity: 'fault', cause: 'Unknown' } })
      }
    }

    switch (type[1]) {
      case 'track': {
        const search = await searchWithDefault(`"${data.name} ${data.artists[0].name}"`)

        if (search.loadType != 'search')
          return resolve(search)

        const track = {
          identifier: search.data[0].info.identifier,
          isSeekable: true,
          author: data.artists[0].name,
          length: search.data[0].info.length,
          isStream: false,
          position: 0,
          title: data.name,
          uri: data.external_urls.spotify,
          artworkUrl: data.album.images[0].url,
          isrc: data.external_ids.isrc,
          sourceName: 'spotify'
        }

        debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'Spotify', track, query })

        resolve({
          loadType: 'track',
          data: {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })

        break
      }
      case 'episode': {
        const search = await searchWithDefault(`"${data.name} ${data.show.publisher}"`)

        if (search.loadType != 'search')
          return resolve(search)

        const track = {
          identifier: search.data[0].info.identifier,
          isSeekable: true,
          author: data.show.publisher,
          length: search.data[0].info.length,
          isStream: false,
          position: 0,
          title: data.name,
          uri: data.external_urls.spotify,
          artworkUrl: data.images[0].url,
          isrc: data.external_ids.isrc,
          sourceName: 'spotify'
        }

        debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'Spotify', track, query })

        resolve({
          loadType: 'track',
          data: {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })

        break
      }
      case 'playlist':
      case 'album': {
        const tracks = []
        let index = 0
        let shouldStop = false

        if (data.tracks.items.length > config.options.maxAlbumPlaylistLength)
          data.tracks.items = data.tracks.items.splice(0, config.options.maxAlbumPlaylistLength)

        data.tracks.items.forEach(async (item) => {
          if (type[1] == 'playlist' ? item.track : item) {
            let search
            if (type[1] == 'playlist') search = await searchWithDefault(`${item.track.name} ${item.track.artists[0].name}`)
            else search = await searchWithDefault(`${item.name} ${item.artists[0].name}`)

            if (search.loadType == 'search') {
              const track = {
                identifier: search.data[0].info.identifier,
                isSeekable: true,
                author: type[1] == 'playlist' ? item.track.artists[0].name : item.artists[0].name,
                length: search.data[0].info.length,
                isStream: false,
                position: 0,
                title: type[1] == 'playlist' ? item.track.name : item.name,
                uri: type[1] == 'playlist' ? item.track.external_urls.spotify : item.external_urls.spotify,
                artworkUrl: search.data[0].info.artworkUrl,
                isrc: null,
                sourceName: 'spotify'
              }

              tracks.push({
                encoded: encodeTrack(track),
                info: track,
                pluginInfo: {}
              })
            }
          }

          if (index == data.tracks.items.length - 1) {
            if (tracks.length == 0) {
              debugLog('loadtracks', 4, { type: 3, sourceName: 'Spotify', query, message: 'No matches found.' })

              return resolve({ loadType: 'empty', data: {} })
            }

            const new_tracks = []
            data.tracks.items.forEach((item2, index2) => {
              tracks.forEach((track2, index3) => {
                if (shouldStop) return;

                if (track2.info.title == (type[1] == 'playlist' ? item2.track.name : item2.name) && track2.info.author == (type[1] == 'playlist' ? item2.track.artists[0].name : item2.artists[0].name)) {
                  track2.info.position = index2
                  new_tracks.push(track2)
                }

                if ((index2 == data.tracks.items.length - 1) && (index3 == tracks.length - 1)) {
                  shouldStop = true

                  debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'Spotify', playlistName: data.name })

                  resolve({
                    loadType: type[1],
                    data: {
                      info: {
                        name: data.name,
                        selectedTrack: 0
                      },
                      pluginInfo: {},
                      tracks: new_tracks
                    }
                  })
                }
              })
            })
          }

          index++
        })

        break
      }
      case 'show': {
        const tracks = []
        let index = 0
        let shouldStop = false

        if (data.episodes.items.length > config.options.maxAlbumPlaylistLength)
          data.episodes.items = data.episodes.items.splice(0, config.options.maxAlbumPlaylistLength)

        data.episodes.items.forEach(async (episode) => {
          const search = await searchWithDefault(`${episode.name} ${episode.show.publisher}`)

          if (search.loadType == 'search') {
            const track = {
              identifier: search.data[0].info.identifier,
              isSeekable: true,
              author: episode.show.publisher,
              length: search.data[0].info.length,
              isStream: false,
              position: 0,
              title: episode.name,
              uri: episode.external_urls.spotify,
              artworkUrl: episode.images[0].url,
              isrc: episode.external_ids.isrc,
              sourceName: 'spotify'
            }

            tracks.push({
              encoded: encodeTrack(track),
              info: track,
              pluginInfo: {}
            })
          }

          if (index == data.episodes.items.length - 1) {
            if (tracks.length == 0) {
              debugLog('loadtracks', 4, { type: 3, sourceName: 'Spotify', query, message: 'No matches found.' })

              return resolve({ loadType: 'empty', data: {} })
            }

            const new_tracks = []
            data.episodes.items.forEach((episode2, index2) => {
              tracks.forEach((track2, index3) => {
                if (shouldStop) return;

                if (track2.info.title == episode2.name && track2.info.author == episode2.publisher) {
                  track2.info.position = index2
                  new_tracks.push(track2)
                }

                if ((index2 == data.episodes.items.length - 1) && (index3 == tracks.length - 1)) {
                  shouldStop = true

                  debugLog('loadtracks', 4, { type: 2, loadType: 'episodes', sourceName: 'Spotify', playlistName: data.name })

                  resolve({
                    loadType: 'show',
                    data: {
                      info: {
                        name: data.name,
                        selectedTrack: 0
                      },
                      pluginInfo: {},
                      tracks: new_tracks
                    }
                  })
                }
              })
            })
          }

          index++
        })

        break
      }
    }
  })
}

export default {
  init,
  search,
  loadFrom
}