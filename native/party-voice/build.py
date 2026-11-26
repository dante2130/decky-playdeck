"""Build the native relay with Sony's DTLS signature compatibility."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent
go = os.environ.get("PLAYDECK_GO", "go")
module = "github.com/pion/webrtc/v4"
subprocess.run([go, "mod", "download", module], cwd=root, check=True)
module_dir = subprocess.check_output(
    [go, "list", "-m", "-f", "{{.Dir}}", module], cwd=root, text=True,
).strip()
source = Path(module_dir) / "dtlstransport.go"
original = source.read_text()
anchor = "\tdtlsConfig.ExtendedMasterSecret = t.api.settingEngine.dtls.extendedMasterSecret\n"
if original.count(anchor) != 1:
    raise SystemExit("Pion DTLS initialization changed. Review the Sony signature compatibility patch.")
compatibility = """\
	// The Sony bridge profile uses RSA/SHA-1 to sign ServerKeyExchange.
	// Keep SDP fingerprint verification and leave the local Steam leg unchanged.
	if profiles := t.api.settingEngine.srtpProtectionProfiles; len(profiles) == 1 &&
		profiles[0] == dtls.SRTP_AES128_CM_HMAC_SHA1_80 {
		dtlsConfig.InsecureHashes = true
		dtlsConfig.SignatureSchemes = []tls.SignatureScheme{
			tls.ECDSAWithP256AndSHA256, tls.ECDSAWithP384AndSHA384, tls.ECDSAWithP521AndSHA512,
			tls.PKCS1WithSHA256, tls.PKCS1WithSHA384, tls.PKCS1WithSHA512, tls.PKCS1WithSHA1,
		}
	}
"""
with tempfile.TemporaryDirectory(prefix="playdeck-go-overlay-") as tmp:
    replacement = Path(tmp) / source.name
    replacement.write_text(original.replace(anchor, anchor + compatibility))
    overlay = Path(tmp) / "overlay.json"
    overlay.write_text(json.dumps({"Replace": {str(source): str(replacement)}}))
    if sys.argv[1:] == ["--test"]:
        args = [go, "test", f"-overlay={overlay}", "./..."]
        env = os.environ
    elif not sys.argv[1:]:
        args = [go, "build", f"-overlay={overlay}", "-trimpath", "-o", "../../dist/party-voice-native", "."]
        env = dict(os.environ, CGO_ENABLED="0", GOOS="linux", GOARCH="amd64")
    else:
        raise SystemExit("Usage: python3 native/party-voice/build.py [--test]")
    subprocess.run(args, cwd=root, env=env, check=True)
