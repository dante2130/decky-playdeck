package main

import (
	"net"
	"strings"
	"sync/atomic"

	"github.com/pion/stun/v3"
	"github.com/pion/transport/v3"
)

const stunNetworkInfo stun.AttrType = 0xc057

type sonyICENetwork struct {
	transport.Net
	remotePassword atomic.Value
}

func (n *sonyICENetwork) setRemoteDescription(sdp string) {
	for _, line := range strings.Split(sdp, "\n") {
		if password, ok := strings.CutPrefix(strings.TrimSpace(line), "a=ice-pwd:"); ok {
			n.remotePassword.Store(password)
			return
		}
	}
	n.remotePassword.Store("")
}

func (n *sonyICENetwork) ListenPacket(network, address string) (net.PacketConn, error) {
	conn, err := n.Net.ListenPacket(network, address)
	if err != nil {
		return nil, err
	}
	return &sonyPacketConn{PacketConn: conn, network: n}, nil
}

func (n *sonyICENetwork) ListenUDP(network string, address *net.UDPAddr) (transport.UDPConn, error) {
	conn, err := n.Net.ListenUDP(network, address)
	if err != nil {
		return nil, err
	}
	return &sonyUDPConn{UDPConn: conn, network: n}, nil
}

type sonyPacketConn struct {
	net.PacketConn
	network *sonyICENetwork
}

func (c *sonyPacketConn) WriteTo(packet []byte, address net.Addr) (int, error) {
	return c.network.writeTo(c.PacketConn, packet, address)
}

type sonyUDPConn struct {
	transport.UDPConn
	network *sonyICENetwork
}

func (c *sonyUDPConn) WriteTo(packet []byte, address net.Addr) (int, error) {
	return c.network.writeTo(c.UDPConn, packet, address)
}

func (n *sonyICENetwork) writeTo(conn net.PacketConn, packet []byte, address net.Addr) (int, error) {
	password, _ := n.remotePassword.Load().(string)
	wire := sonyICERequest(packet, password)
	written, err := conn.WriteTo(wire, address)
	if written == len(wire) {
		written = len(packet)
	}
	return written, err
}

func sonyICERequest(packet []byte, password string) []byte {
	if password == "" || !stun.IsMessage(packet) {
		return packet
	}
	original := &stun.Message{Raw: append([]byte(nil), packet...)}
	if original.Decode() != nil || original.Type != stun.BindingRequest ||
		original.Contains(stunNetworkInfo) || !original.Contains(stun.AttrUsername) {
		return packet
	}
	integrity := stun.NewShortTermIntegrity(password)
	if integrity.Check(original) != nil {
		return packet
	}

	request, err := stun.Build(stun.NewTransactionIDSetter(original.TransactionID), original.Type)
	if err != nil {
		return packet
	}
	for _, attribute := range original.Attributes {
		switch attribute.Type {
		case stun.AttrMessageIntegrity, stun.AttrFingerprint:
			continue
		}
		request.Add(attribute.Type, attribute.Value)
		if attribute.Type == stun.AttrUsername {
			// PS App sent network ID 4 and cost 10 in all four bridge captures.
			request.Add(stunNetworkInfo, []byte{0, 4, 0, 10})
		}
	}
	if integrity.AddTo(request) != nil || stun.Fingerprint.AddTo(request) != nil {
		return packet
	}
	return request.Raw
}
