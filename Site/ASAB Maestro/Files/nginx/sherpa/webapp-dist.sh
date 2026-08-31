#!/bin/sh

# Test by:
# $ ./gov.sh compose up nginx-1-webapp-dist

CACHE_DIR=/var/cache/nginx
WEBROOT_DIR=/webroot
TMP_DIR=/tmp

MAXSIZE=100M

# args: url, name, archive_path
# return 0: downloaded, 1: try next URL, 2: up-to-date
try_download() {
	url="$1"
	name="$2"
	archive="$3"

	http_code=$(curl --silent --show-error --fail \
		--etag-save "$CACHE_DIR/$name.etag-new" \
		--etag-compare "$CACHE_DIR/$name.etag" \
		--max-filesize ${MAXSIZE} \
		--retry 3 \
		--retry-delay 1 \
		-w "%{http_code}" \
		-o "$archive" \
		"$url") || true

	case "$http_code" in
		200)
			if [ -f "$archive" ]; then
				return 0
			fi
			return 2
			;;
		304)
			return 2
			;;
		404)
			echo "Version not found (404): $url"
			;;
		*)
			echo "Failed to download from $url (HTTP $http_code). Trying next source if available..."
			;;
	esac
	rm -f "$archive" "$CACHE_DIR/$name.etag-new"
	return 1
}

# args: urls_str, name, archive_ext (tar.xz|tar.lzma), decompress_cmd (xzcat|lzcat)
install_webapp() {
	urls_str="$1"
	name="$2"
	archive_ext="$3"
	decompress_cmd="$4"

	cd "$WEBROOT_DIR" || return

	rm -rf "$name.new" "$CACHE_DIR/$name.etag-new"

	archive="$TMP_DIR/$name.$archive_ext"

	# try_download return code captured with '|| rc=$?' — the sherpa invokes this script with 'sh -e'
	source_url=""
	for url in $(echo "$urls_str" | tr ',' '\n' | shuf); do
		rc=0
		try_download "$url" "$name" "$archive" || rc=$?
		case $rc in
			0)
				source_url="$url"
				break
				;;
			1)
				# Download failed — try next URL
				;;
			2)
				echo "$name already installed and up-to-date."
				rm -f "$CACHE_DIR/$name.etag-new"
				return
				;;
		esac
	done

	if [ ! -f "$archive" ]; then
		echo "Error: Failed to download $name from all available sources."
		return
	fi

	mkdir "$name.new"
	if ! $decompress_cmd "$archive" | tar x -C "./$name.new"; then
		echo "Error: Downloaded file is not a valid archive for $name."
		rm -rf "./$name.new" "$archive" "$CACHE_DIR/$name.etag-new"
		return
	fi

	rm -rf "./$name" "$archive"
	mv -T "./$name.new" "./$name"
	mv "$CACHE_DIR/$name.etag-new" "$CACHE_DIR/$name.etag"
	echo "$name installed from $source_url."
}

mkdir -p "$TMP_DIR"

if [ -f "/sherpa/webapps.dist" ]; then

	# Process the file line by line
	while read -r line; do

		# Get the function/command from the first 'word' of the line
		cmd=$(echo "$line" | cut -d " " -f 1)

		# Get the arguments by excluding the first 'word'
		args=$(echo "$line" | cut -d " " -f 2-)
		
		# Get the last argument (name)
		name=$(echo "$args" | cut -d " " -f 2)

		# Switch based on the command
		case "$cmd" in
			mfe)
				echo "Installing $name (mfe) ..."
				install_webapp $args tar.xz xzcat
				;;
			spa)
				echo "Installing $name (spa) ..."
				install_webapp $args tar.lzma lzcat
				;;
			*)
				echo "Unknown distribution method: $cmd"
				;;
		esac

	done < "/sherpa/webapps.dist"
else
	echo "File /sherpa/webapps.dist not found. No webapps installed."
fi
