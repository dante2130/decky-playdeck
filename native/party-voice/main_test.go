package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestBridgeRelaysOpusAndControl(t *testing.T) {
	steam, steamMic, err := newPeer(48000, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { steam.Close() })
	sony, sonyMic, err := newPeer(16000, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sony.Close() })
	if sonyMic.StreamID() != "-" {
		t.Fatal("Sony microphone must use the streamless SDP identifier")
	}
	if _, err := uuid.Parse(sonyMic.ID()); err != nil {
		t.Fatal("Sony microphone track must use a UUID", err)
	}
	if _, err := sony.CreateDataChannel("test-offered", nil); err != nil {
		t.Fatal(err)
	}
	makeOffer := func(pc *webrtc.PeerConnection) string {
		offer, err := pc.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		gathered := webrtc.GatheringCompletePromise(pc)
		if err := pc.SetLocalDescription(offer); err != nil {
			t.Fatal(err)
		}
		select {
		case <-gathered:
		case <-time.After(5 * time.Second):
			t.Fatal("offer ICE gather timed out")
		}
		return pc.LocalDescription().SDP
	}
	steamOffer, sonyOffer := makeOffer(steam), makeOffer(sony)
	sonyOffer = strings.ReplaceAll(sonyOffer, "IN IP4 0.0.0.0", "IN 172.30.36.136 IP4")
	bridge := &bridge{channels: make(map[int]*webrtc.DataChannel)}
	result, err := bridge.start(command{Offer: sonyOffer, LocalOffer: steamOffer})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bridge.sony.Close(); bridge.local.Close() })
	if !strings.Contains(result["answer"].(string), "a=msid:- ") {
		t.Fatal("Sony answer is missing its streamless microphone track binding")
	}
	packets := func(pc *webrtc.PeerConnection) chan uint32 {
		output := make(chan uint32, 16)
		pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			for {
				packet, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				select {
				case output <- packet.Timestamp:
				default:
				}
			}
		})
		return output
	}
	atSteam, atSony := packets(steam), packets(sony)
	for pc, key := range map[*webrtc.PeerConnection]string{steam: "localAnswer", sony: "answer"} {
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: result[key].(string)}); err != nil {
			t.Fatal(err)
		}
	}
	expect := func(packets chan uint32, previous uint32, delta uint32) {
		select {
		case timestamp := <-packets:
			if timestamp != previous+delta {
				t.Fatalf("timestamp = %d, expected %d", timestamp, previous+delta)
			}
		default:
			t.Fatal("missing relayed audio packet")
		}
	}
	deadline := time.Now().Add(8 * time.Second)
	for steam.ConnectionState() != webrtc.PeerConnectionStateConnected || sony.ConnectionState() != webrtc.PeerConnectionStateConnected {
		if time.Now().After(deadline) {
			t.Fatal("local WebRTC peers did not connect")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for i := uint16(0); i < 2; i++ {
		for track, step := range map[*webrtc.TrackLocalStaticRTP]uint32{steamMic: 1920, sonyMic: 640} {
			err := track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 100 + i, Timestamp: 10000 + uint32(i)*step}, Payload: []byte{0xf8, 0xff, 0xfe}})
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	for len(atSony) < 2 || len(atSteam) < 2 {
		if time.Now().After(deadline) {
			t.Fatal("local WebRTC peers did not receive audio")
		}
		time.Sleep(10 * time.Millisecond)
	}
	expect(atSony, 10000, 0)
	expect(atSony, 10000, 640)
	expect(atSteam, 10000, 0)
	expect(atSteam, 10000, 1920)

	received := make(chan string, 1)
	sony.OnDataChannel(func(channel *webrtc.DataChannel) {
		if channel.Label() == "bridge" {
			channel.OnMessage(func(message webrtc.DataChannelMessage) { received <- string(message.Data) })
		}
	})
	bridge.exchange([]channelCommand{{Type: "open", Key: 1, Label: "bridge", Ordered: true}})
	for {
		opened := false
		for _, e := range bridge.exchange(nil)["events"].([]event) {
			opened = opened || (e.Type == "open" && e.Key == 1)
		}
		if opened {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("bridge control channel did not open")
		}
		time.Sleep(10 * time.Millisecond)
	}
	bridge.exchange([]channelCommand{{Type: "send", Key: 1, Binary: []byte("hello")}})
	select {
	case message := <-received:
		if message != "hello" {
			t.Fatalf("unexpected control message %q", message)
		}
	case <-time.After(time.Second):
		t.Fatal("control message did not reach peer")
	}
}

func TestNormalizeSonyCandidate(t *testing.T) {
	const host = "100-42-106-187-rtcb.np.communication.playstation.net"
	offer := "c=IN 172.30.36.136 IP4\r\na=candidate:1 1 udp 1 " + host + " 5000 typ host\r\n"
	expected := "c=IN IP4 172.30.36.136\r\na=candidate:1 1 udp 1 100.42.106.187 5000 typ host\r\n"
	normalized, err := normalizeSonySDP(offer, func(got string) (string, error) {
		if got != host {
			t.Fatalf("unexpected candidate host %q", got)
		}
		return "100.42.106.187", nil
	})
	if err != nil || normalized != expected {
		t.Fatalf("candidate normalization = %q, %v", normalized, err)
	}
}

func TestSonyAnswerStreamBindingLayout(t *testing.T) {
	input := "v=0\r\na=msid-semantic:WMS *\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=rtcp-mux\r\na=ssrc:123 cname:-\r\na=ssrc:123 msid:- test-track\r\na=ssrc:123 mslabel:-\r\na=ssrc:123 label:test-track\r\na=msid:- test-track\r\na=sendonly\r\n"
	output := sonyAnswerSDP(input, false)
	if !strings.Contains(output, "a=msid-semantic: WMS *\r\n") ||
		!strings.Contains(output, "a=mid:0\r\na=msid:- test-track\r\n") {
		t.Fatal("Sony answer is missing its Unified Plan stream binding")
	}
	if strings.Count(output, "a=ssrc:") != 1 || !strings.Contains(output, "a=ssrc:123 cname:-") {
		t.Fatal("Sony answer retained conflicting legacy stream bindings")
	}
}

func TestBridgeControlChannelPreservesReliability(t *testing.T) {
	peer, _, err := newPeer(16000, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { peer.Close() })
	b := &bridge{sony: peer, channels: make(map[int]*webrtc.DataChannel)}
	var cmd channelCommand
	if err := json.Unmarshal([]byte(`{"type":"open","key":1,"label":"peer_0","ordered":true,"maxRetransmits":0}`), &cmd); err != nil {
		t.Fatal(err)
	}
	b.exchange([]channelCommand{cmd})
	dc := b.channels[1]
	if dc == nil || !dc.Ordered() || dc.MaxRetransmits() == nil || *dc.MaxRetransmits() != 0 {
		t.Fatal("PS App ordered control channel must preserve zero retransmissions")
	}
}
