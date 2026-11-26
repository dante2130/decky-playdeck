package main

import (
	"bytes"
	"testing"

	"github.com/pion/stun/v3"
)

func TestSonyICERequestPreservesAuthentication(t *testing.T) {
	const password = "fake-remote-ice-password"
	integrity := stun.NewShortTermIntegrity(password)
	original := stun.MustBuild(stun.TransactionID, stun.BindingRequest,
		stun.NewUsername("sony:deck"), integrity, stun.Fingerprint)
	before := bytes.Clone(original.Raw)
	request := &stun.Message{Raw: sonyICERequest(original.Raw, password)}
	if err := request.Decode(); err != nil {
		t.Fatal(err)
	}
	if err := request.Check(integrity, stun.Fingerprint); err != nil {
		t.Fatal(err)
	}
	networkInfo, err := request.Get(stunNetworkInfo)
	if err != nil || !bytes.Equal(networkInfo, []byte{0, 4, 0, 10}) {
		t.Fatalf("unexpected network info: %x (%v)", networkInfo, err)
	}
	if request.TransactionID != original.TransactionID || !bytes.Equal(before, original.Raw) {
		t.Fatal("changed the transaction ID or original binding request")
	}
	if !bytes.Equal(sonyICERequest(original.Raw, "wrong-password"), before) {
		t.Fatal("changed a packet authenticated with different credentials")
	}
}
