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

	if [ ! -f "$archive" ]; then
		if [ "$http_code" = "304" ] || [ "$http_code" = "200" ]; then
			# ETag check indicates no change (304 or matching ETag)
			return 2
		fi
	else
		if [ "$http_code" = "200" ]; then
			return 0
		fi
	fi

	case "$http_code" in
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

# args: urls_str, name, kind (mfe|spa), archive_ext (tar.xz|tar.lzma), decompress (xzcat|lzcat)
install_webapp() {
	urls_str="$1"
	name="$2"
	kind="$3"
	archive_ext="$4"
	decompress="$5"

	echo "Installing $name ($kind) ..."

	cd "$WEBROOT_DIR" || return

	rm -rf "$name.new" "$CACHE_DIR/$name.etag-new"

	archive="$TMP_DIR/$name.$archive_ext"

	# try_download must run inside 'if' — the sherpa invokes this script with 'sh -e'
	for url in $(echo "$urls_str" | tr ',' ' '); do
		if try_download "$url" "$name" "$archive"; then
			break
		fi
		rc=$?
		if [ $rc -eq 2 ]; then
			echo "$name already installed and up-to-date."
			rm -f "$CACHE_DIR/$name.etag-new"
			return
		fi
	done

	if [ ! -f "$archive" ]; then
		echo "Error: Failed to download $name from all available sources."
		return
	fi

	mkdir "$name.new"
	if ! $decompress "$archive" | tar x -C "./$name.new"; then
		echo "Error: Downloaded file is not a valid archive for $name."
		rm -rf "./$name.new" "$archive" "$CACHE_DIR/$name.etag-new"
		return
	fi

	rm -rf "./$name" "$archive"
	mv -T "./$name.new" "./$name"
	mv "$CACHE_DIR/$name.etag-new" "$CACHE_DIR/$name.etag"
	echo "$name installed."
}

install_mfe() {
	install_webapp "$1" "$2" mfe tar.xz xzcat
}

install_spa() {
	install_webapp "$1" "$2" spa tar.lzma lzcat
}


mkdir -p "$TMP_DIR"

if [ -f "/sherpa/webapps.dist" ]; then

	# Process the file line by line
	while read -r line; do

		# Get the function/command from the first 'word' of the line
		cmd=$(echo "$line" | cut -d " " -f 1)

		# Get the arguments by excluding the first 'word'
		args=$(echo "$line" | cut -d " " -f 2-)

		# Switch based on the command
		case "$cmd" in
			mfe)
				# Call the mfe function and pass all arguments
				install_mfe $args
				;;

			spa)
				# Call the spa function and pass all arguments
				install_spa $args
				;;

			*)
				echo "Unknown distribution method: $cmd"
				;;
		esac

	done < "/sherpa/webapps.dist"
else
	echo "File /sherpa/webapps.dist not found. No webapps installed."
fi
