; Windows installer additions (electron-builder NSIS include).
;
; Direct mode receives files over a TCP connection from the other Hopline app on the same network. Without a
; firewall rule, Windows blocks (or throttles) that inbound traffic and Hopline falls back to slower WebRTC.
; The rule is limited to Hopline.exe, inbound TCP, and *private* networks only (never public Wi-Fi).

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Hopline Direct mode"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Hopline Direct mode" dir=in action=allow program="$INSTDIR\Hopline.exe" protocol=TCP profile=private enable=yes'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Hopline Direct mode"'
!macroend
