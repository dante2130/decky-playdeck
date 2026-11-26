package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/pion/dtls/v3"
	"github.com/pion/logging"
	"github.com/pion/sdp/v3"
	"github.com/pion/transport/v3/stdnet"
	"github.com/pion/webrtc/v4"
)

type command struct {
	Type       string           `json:"type"`
	Offer      string           `json:"offer"`
	LocalOffer string           `json:"localOffer"`
	Commands   []channelCommand `json:"commands"`
}

func normalizeSonySDP(offer string, lookup func(string) (string, error)) (string, error) {
	lines := strings.Split(offer, "\n")
	for i, line := range lines {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if strings.HasPrefix(fields[0], "a=candidate:") && len(fields) >= 8 {
			host := strings.ToLower(strings.TrimSuffix(fields[4], "."))
			if strings.HasSuffix(host, ".np.communication.playstation.net") {
				address, err := lookup(host)
				if err != nil {
					return "", fmt.Errorf("resolve Sony ICE candidate: %w", err)
				}
				fields[4] = address
				lines[i] = strings.Join(fields, " ")
				if strings.HasSuffix(line, "\r") {
					lines[i] += "\r"
				}
			}
			continue
		}
		var prefix string
		var addressFields []string
		switch {
		case strings.HasPrefix(fields[0], "c="):
			prefix = "c=IN"
			addressFields = fields
			addressFields[0] = strings.TrimPrefix(fields[0], "c=")
		case strings.HasPrefix(fields[0], "o=") && len(fields) >= 4:
			prefix = strings.Join(fields[:3], " ") + " IN"
			addressFields = fields[3:]
		default:
			continue
		}
		addressType, address := "IP4", "0.0.0.0"
		for _, field := range addressFields {
			host, _, _ := strings.Cut(field, "/")
			ip := net.ParseIP(host)
			if ip == nil {
				continue
			}
			address = host
			if ip.To4() == nil {
				addressType = "IP6"
			}
			break
		}
		lines[i] = prefix + " " + addressType + " " + address
		if strings.HasSuffix(line, "\r") {
			lines[i] += "\r"
		}
	}

	return strings.Join(lines, "\n"), nil
}

func (b *bridge) answerSony(offer string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	addresses := map[string]string{}
	offer, err := normalizeSonySDP(offer, func(host string) (string, error) {
		if address := addresses[host]; address != "" {
			return address, nil
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return "", err
		}
		for _, ip := range ips {
			if ip.Is4() {
				addresses[host] = ip.String()
				return ip.String(), nil
			}
		}
		if len(ips) > 0 {
			addresses[host] = ips[0].String()
			return addresses[host], nil
		}
		return "", fmt.Errorf("no addresses returned")
	})
	if err != nil {
		return "", err
	}
	b.sonyNetwork.setRemoteDescription(offer)
	localSDP, err := answer(b.sony, offer)
	if err != nil {
		return "", err
	}
	return sonyAnswerSDP(localSDP, strings.Contains(offer, " DTLS/SCTP ")), nil
}

// Serialize bundled transport attributes in the order used by Steam's answer.
// The bridge returned a null ICE username for Pion's SDP despite accepting it.
func sonyAnswerSDP(localSDP string, legacySCTP bool) string {
	sections := strings.Split(localSDP, "\r\nm=")
	var session []string
	var fingerprint string
	for _, line := range strings.Split(sections[0], "\r\n") {
		if strings.HasPrefix(line, "a=fingerprint:") {
			fingerprint = line
		} else {
			if strings.HasPrefix(line, "a=msid-semantic:") {
				line = "a=msid-semantic: " + strings.TrimSpace(strings.TrimPrefix(line, "a=msid-semantic:"))
			}
			session = append(session, line)
		}
	}
	for i, line := range session {
		if strings.HasPrefix(line, "a=group:BUNDLE ") {
			for j := i; j > 0 && strings.HasPrefix(session[j-1], "a="); j-- {
				session[j], session[j-1] = session[j-1], session[j]
			}
			break
		}
	}
	sections[0] = strings.Join(session, "\r\n")
	for i := 1; i < len(sections); i++ {
		lines := strings.Split(strings.TrimSuffix(sections[i], "\r\n"), "\r\n")
		var header, candidates, media []string
		var publicAddress, publicPort string
		transport := make(map[string]string)
		transport["a=fingerprint"] = fingerprint
		legacyData := legacySCTP && strings.HasPrefix(lines[0], "application 9 UDP/DTLS/SCTP ")
		if legacyData {
			lines[0] = "application 9 DTLS/SCTP 5000"
		}
		for _, line := range lines {
			key, _, _ := strings.Cut(line, ":")
			switch key {
			case "a=candidate":
				fields := strings.Fields(line)
				if len(fields) >= 8 && fields[1] == "1" {
					// Pion includes an ICE ufrag extension on its candidates.
					// Steam supplies the credentials on the media section and
					// marks the candidates with the ICE generation instead.
					candidate := append([]string(nil), fields[:8]...)
					for j := 8; j+1 < len(fields); j += 2 {
						if fields[j] == "raddr" || fields[j] == "rport" {
							candidate = append(candidate, fields[j:j+2]...)
						}
					}
					candidates = append(candidates, strings.Join(append(candidate, "generation", "0"), " "))
					if fields[7] == "srflx" && net.ParseIP(fields[4]).To4() != nil {
						publicAddress, publicPort = fields[4], fields[5]
					}
				}
			case "a=ice-ufrag", "a=ice-pwd", "a=ice-options", "a=fingerprint", "a=setup", "a=mid", "a=msid":
				transport[key] = line
			case "a=ssrc":
				// Unified Plan uses a=msid for the stream/track association.
				// Match Steam's answer by retaining only the SSRC CNAME.
				if strings.Contains(line, " cname:") {
					media = append(media, line)
				}
			case "a=end-of-candidates":
				// All candidates are sent with the answer.
			case "a=sendrecv", "a=max-message-size":
				if !legacyData {
					media = append(media, line)
				}
			case "a=sctp-port":
				if legacyData {
					media = append(media, "a=sctpmap:5000 webrtc-datachannel 1024")
				} else {
					media = append(media, line)
				}
			default:
				if strings.HasPrefix(line, "a=") {
					media = append(media, line)
				} else {
					header = append(header, line)
				}
			}
		}
		if transport["a=ice-options"] == "" {
			transport["a=ice-options"] = "a=ice-options:trickle"
		}
		if publicAddress != "" && len(header) == 2 && strings.HasPrefix(header[0], "audio 9 ") {
			header[0] = strings.Replace(header[0], "audio 9 ", "audio "+publicPort+" ", 1)
			header[1] = "c=IN IP4 " + publicAddress
			header = append(header, "a=rtcp:"+publicPort+" IN IP4 "+publicAddress)
		}
		header = append(header, candidates...)
		for _, key := range []string{"a=ice-ufrag", "a=ice-pwd", "a=ice-options", "a=fingerprint", "a=setup", "a=mid", "a=msid"} {
			if line := transport[key]; line != "" {
				header = append(header, line)
			}
		}
		sections[i] = strings.Join(append(header, media...), "\r\n")
	}
	return strings.Join(sections, "\r\nm=") + "\r\n"
}

type channelCommand struct {
	Type           string  `json:"type"`
	Key            int     `json:"key"`
	Label          string  `json:"label"`
	Ordered        bool    `json:"ordered"`
	MaxRetransmits *uint16 `json:"maxRetransmits,omitempty"`
	ID             *uint16 `json:"id"`
	Text           *string `json:"text"`
	Binary         []byte  `json:"binary"`
}

type event struct {
	Type   string  `json:"type"`
	Key    int     `json:"key"`
	Label  string  `json:"label,omitempty"`
	ID     *uint16 `json:"id,omitempty"`
	Text   *string `json:"text,omitempty"`
	Binary []byte  `json:"binary,omitempty"`
}

type bridge struct {
	sony, local    *webrtc.PeerConnection
	sonyNetwork    *sonyICENetwork
	mic, speaker   *webrtc.TrackLocalStaticRTP
	channels       map[int]*webrtc.DataChannel
	events         []event
	nextRemoteKey  int
	eventLock      sync.Mutex
	sent, received atomic.Uint64
}

func newPeer(clock uint32, loopback bool, sonyNetwork *sonyICENetwork) (*webrtc.PeerConnection, *webrtc.TrackLocalStaticRTP, error) {
	codec := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: clock, Channels: 2}
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: codec, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, nil, err
	}
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.AudioLevelURI},
		webrtc.RTPCodecTypeAudio); err != nil {
		return nil, nil, err
	}
	settings := webrtc.SettingEngine{}
	if sonyNetwork != nil {
		settings.SetNet(sonyNetwork)
		// Sony selected this SRTP profile in all four PlayStation App traces.
		settings.SetSRTPProtectionProfiles(dtls.SRTP_AES128_CM_HMAC_SHA1_80)
		logger := logging.NewDefaultLoggerFactory()
		logger.ScopeLevels["pc"] = logging.LogLevelWarn
		logger.ScopeLevels["dtls"] = logging.LogLevelWarn
		settings.LoggerFactory = logger
	}
	configuration := webrtc.Configuration{}
	if loopback {
		settings.SetIncludeLoopbackCandidate(true)
		settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	} else {
		// Match the ICE credential lengths used by Steam's working Sony answer.
		var credentials [21]byte
		if _, err := rand.Read(credentials[:]); err != nil {
			return nil, nil, fmt.Errorf("generate Sony ICE credentials: %w", err)
		}
		settings.SetICECredentials(
			base64.RawStdEncoding.EncodeToString(credentials[:3]),
			base64.RawStdEncoding.EncodeToString(credentials[3:]),
		)
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
		configuration.ICEServers = []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings)).NewPeerConnection(configuration)
	if err != nil {
		return nil, nil, err
	}
	streamID, trackID := "voice_chat", "voice_chat"
	if !loopback {
		// Match the streamless SDP track Sony registers for PS App.
		// Miranda's voice_chat media identifier is announced separately.
		streamID, trackID = "-", uuid.NewString()
	}
	track, err := webrtc.NewTrackLocalStaticRTP(codec, trackID, streamID)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	if _, err := pc.AddTrack(track); err != nil {
		pc.Close()
		return nil, nil, err
	}
	return pc, track, nil
}

func answer(pc *webrtc.PeerConnection, offer string) (string, error) {
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		return "", fmt.Errorf("read remote offer: %w", err)
	}
	sdp, err := pc.CreateAnswer(nil)
	if err != nil {
		return "", fmt.Errorf("create answer: %w", err)
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(sdp); err != nil {
		return "", fmt.Errorf("set local answer: %w", err)
	}
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		return "", fmt.Errorf("ICE candidate gathering timed out")
	}
	return pc.LocalDescription().SDP, nil
}

func audioLevelID(extensions []webrtc.RTPHeaderExtensionParameter) uint8 {
	for _, extension := range extensions {
		if extension.URI == sdp.AudioLevelURI {
			return uint8(extension.ID)
		}
	}
	return 0
}

func forward(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver, target *webrtc.TrackLocalStaticRTP, connection *webrtc.PeerConnection,
	from, to uint32, count *atomic.Uint64,
) {
	var clock timestampClock
	sourceLevelID := audioLevelID(receiver.GetParameters().HeaderExtensions)
	var targetLevelID uint8
	var targetKnown bool
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		packet.Timestamp = clock.convert(packet.Timestamp, from, to)
		if connection.ConnectionState() != webrtc.PeerConnectionStateConnected {
			continue
		}
		if !targetKnown {
			for _, sender := range connection.GetSenders() {
				if sender.Track() == target {
					targetLevelID = audioLevelID(sender.GetParameters().HeaderExtensions)
					break
				}
			}
			targetKnown = true
		}
		level := packet.GetExtension(sourceLevelID)
		// RTP extension IDs belong to each leg’s SDP negotiation.
		packet.Extension = false
		packet.Extensions = nil
		packet.CSRC = nil
		if targetLevelID != 0 && sourceLevelID != 0 && len(level) == 1 {
			_ = packet.SetExtension(targetLevelID, level)
		}
		if target.WriteRTP(packet) == nil {
			count.Add(1)
		}
	}
}

type timestampClock struct {
	initialized bool
	last        uint32
	output      uint32
	remainder   uint64
}

func (c *timestampClock) convert(input, from, to uint32) uint32 {
	if !c.initialized {
		c.initialized = true
		c.last, c.output = input, input
		return input
	}
	delta := int64(int32(input - c.last))
	if delta < 0 {
		return c.output - uint32((-delta*int64(to)+int64(from)-1)/int64(from))
	}
	ticks := uint64(delta)*uint64(to) + c.remainder
	c.output += uint32(ticks / uint64(from))
	c.remainder = ticks % uint64(from)
	c.last = input
	return c.output
}

func (b *bridge) push(e event) {
	b.eventLock.Lock()
	defer b.eventLock.Unlock()
	if len(b.events) < 128 {
		b.events = append(b.events, e)
	}
}

// Describe signaling fields while omitting account and peer identifiers.
func controlLogValue(key string, value any) any {
	if strings.Contains(strings.ToLower(key), "id") && key != "mid" && key != "media_identifier" && key != "msids" {
		if text, ok := value.(string); ok {
			numeric := text != ""
			for _, character := range text {
				numeric = numeric && character >= '0' && character <= '9'
			}
			return fmt.Sprintf("<string length=%d numeric=%t>", len(text), numeric)
		}
		return fmt.Sprintf("<%T>", value)
	}
	switch item := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(item))
		for childKey, child := range item {
			result[childKey] = controlLogValue(childKey, child)
		}
		return result
	case []any:
		result := make([]any, len(item))
		for index, child := range item {
			result[index] = controlLogValue(key, child)
		}
		return result
	default:
		return value
	}
}

func logMediaAnnouncement(direction string, payload []byte) {
	var message map[string]any
	if json.Unmarshal(payload, &message) != nil {
		return
	}
	if message["type"] == "user_table_updated" {
		summary, err := json.Marshal(controlLogValue("", message))
		if err == nil && len(summary) <= 8192 {
			fmt.Fprintf(os.Stderr, "Sony control announcement %s %s\n", direction, summary)
		}
		return
	}
	if message["type"] != nil {
		fmt.Fprintf(os.Stderr, "Sony control event %s type=%v category=%v\n", direction,
			message["type"], message["category"])
	}
}

func (b *bridge) register(key int, dc *webrtc.DataChannel) {
	b.eventLock.Lock()
	b.channels[key] = dc
	b.eventLock.Unlock()
	dc.OnOpen(func() { b.push(event{Type: "open", Key: key, ID: dc.ID()}) })
	dc.OnClose(func() {
		b.eventLock.Lock()
		delete(b.channels, key)
		b.eventLock.Unlock()
		b.push(event{Type: "close", Key: key})
	})
	dc.OnMessage(func(message webrtc.DataChannelMessage) {
		if len(message.Data) > 65536 {
			return
		}
		logMediaAnnouncement("received", message.Data)
		e := event{Type: "message", Key: key}
		if message.IsString {
			value := string(message.Data)
			e.Text = &value
		} else {
			e.Binary = message.Data
		}
		b.push(e)
	})
}

func (b *bridge) exchange(commands []channelCommand) map[string]any {
	for _, cmd := range commands {
		if cmd.Type == "open" {
			negotiated := cmd.ID != nil
			dc, err := b.sony.CreateDataChannel(cmd.Label, &webrtc.DataChannelInit{Ordered: &cmd.Ordered, Negotiated: &negotiated, ID: cmd.ID, MaxRetransmits: cmd.MaxRetransmits})
			if err != nil {
				b.push(event{Type: "close", Key: cmd.Key})
				continue
			}
			b.register(cmd.Key, dc)
			continue
		}
		b.eventLock.Lock()
		dc := b.channels[cmd.Key]
		b.eventLock.Unlock()
		if dc == nil {
			continue
		}
		switch {
		case cmd.Type == "close":
			dc.Close()
		case cmd.Type == "send" && cmd.Text != nil:
			logMediaAnnouncement("sent", []byte(*cmd.Text))
			dc.SendText(*cmd.Text)
		case cmd.Type == "send":
			logMediaAnnouncement("sent", cmd.Binary)
			dc.Send(cmd.Binary)
		}
	}
	b.eventLock.Lock()
	var events []event
	size := 0
	for _, e := range b.events {
		size += len(e.Binary) + len(e.Label) + 128
		if e.Text != nil {
			size += 6 * len(*e.Text)
		}
		if size > 512*1024 {
			break
		}
		events = append(events, e)
	}
	b.events = b.events[len(events):]
	b.eventLock.Unlock()
	remoteAudioReport := false
	for _, stat := range b.sony.GetStats() {
		if _, ok := stat.(webrtc.RemoteInboundRTPStreamStats); ok {
			remoteAudioReport = true
			break
		}
	}
	return map[string]any{
		"events": events, "sent": b.sent.Load(), "received": b.received.Load(),
		"state": b.sony.ConnectionState().String(), "remoteAudioReport": remoteAudioReport,
		"iceState": b.sony.ICEConnectionState().String(),
	}
}

func main() {
	reader := bufio.NewScanner(os.Stdin)
	reader.Buffer(make([]byte, 65536), 1024*1024)
	output := json.NewEncoder(os.Stdout)
	b := &bridge{channels: make(map[int]*webrtc.DataChannel)}
	defer func() {
		if b.sony != nil {
			b.sony.Close()
		}
		if b.local != nil {
			b.local.Close()
		}
	}()
	for reader.Scan() {
		var cmd command
		if err := json.Unmarshal(reader.Bytes(), &cmd); err != nil {
			output.Encode(map[string]string{"error": err.Error()})
			continue
		}
		var response map[string]any
		var err error
		switch cmd.Type {
		case "start":
			response, err = b.start(cmd)
		case "answer":
			var sdp string
			sdp, err = b.answerSony(cmd.Offer)
			response = map[string]any{"answer": sdp}
		case "exchange":
			response = b.exchange(cmd.Commands)
		default:
			err = fmt.Errorf("unknown voice helper command")
		}
		if err != nil {
			response = map[string]any{"error": err.Error()}
		}
		if err := output.Encode(response); err != nil {
			return
		}
	}
}

func (b *bridge) start(cmd command) (map[string]any, error) {
	network, err := stdnet.NewNet()
	if err != nil {
		return nil, fmt.Errorf("create Sony ICE network: %w", err)
	}
	b.sonyNetwork = &sonyICENetwork{Net: network}
	b.sony, b.mic, err = newPeer(16000, false, b.sonyNetwork)
	if err != nil {
		return nil, fmt.Errorf("create Sony connection: %w", err)
	}
	b.sony.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		fmt.Fprintf(os.Stderr, "Sony relay ICE: %s\n", state)
	})
	b.sony.SCTP().Transport().OnStateChange(func(state webrtc.DTLSTransportState) {
		fmt.Fprintf(os.Stderr, "Sony relay DTLS: %s\n", state)
	})
	b.local, b.speaker, err = newPeer(48000, true, nil)
	if err != nil {
		return nil, fmt.Errorf("create local Steam connection: %w", err)
	}
	b.sony.OnDataChannel(func(dc *webrtc.DataChannel) {
		b.eventLock.Lock()
		b.nextRemoteKey--
		key := b.nextRemoteKey
		b.events = append(b.events, event{Type: "incoming", Key: key, Label: dc.Label(), ID: dc.ID()})
		b.eventLock.Unlock()
		b.register(key, dc)
	})
	b.local.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		forward(track, receiver, b.mic, b.sony, 48000, 16000, &b.sent)
	})
	// Sony's primary bridge audio stream uses its negotiated 16 kHz RTP clock.
	b.sony.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		forward(track, receiver, b.speaker, b.local, 16000, 48000, &b.received)
	})
	localAnswer, err := answer(b.local, cmd.LocalOffer)
	if err != nil {
		return nil, fmt.Errorf("local Steam connection: %w", err)
	}
	sonyAnswer, err := b.answerSony(cmd.Offer)
	if err != nil {
		return nil, fmt.Errorf("Sony bridge connection: %w", err)
	}
	return map[string]any{"answer": sonyAnswer, "localAnswer": localAnswer}, nil
}
