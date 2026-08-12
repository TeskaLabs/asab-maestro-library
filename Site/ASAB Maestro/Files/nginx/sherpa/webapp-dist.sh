#!/bin/sh

# Test by:
# $ ./gov.sh compose up nginx-1-webapp-dist

CACHE_DIR=/var/cache/nginx
WEBROOT_DIR=/webroot
TMP_DIR=/tmp

MAXSIZE=100M

install_mfe() {
	urls_str="$1"
	name="$2"
	echo "Installing $name (mfe) ..."
	
	cd "$WEBROOT_DIR" || return

	rm -rf "$name.new" "$CACHE_DIR/$name.etag-new"
	
	# Replace commas with spaces so standard 'sh' can loop through them
	urls_spaced=$(echo "$urls_str" | tr ',' ' ')

	downloaded=0
	up_to_date=0

	# Try each URL in order
	for url in $urls_spaced; do
		# By putting curl directly inside the 'if' statement, we prevent 
		# 'sh -e' from immediately crashing the script if the download fails.
		if curl --silent --show-error \
			--etag-save "$CACHE_DIR/$name.etag-new" \
			--etag-compare "$CACHE_DIR/$name.etag" \
			--max-filesize ${MAXSIZE} \
			--retry 3 \
			--retry-delay 1 \
			-o "$TMP_DIR/$name.tar.xz" \
			"$url"; then
			
			if [ ! -f "$TMP_DIR/$name.tar.xz" ]; then
				# ETag check indicates no change
				up_to_date=1
			else
				# Successfully downloaded a new file
				downloaded=1
			fi
			# Success - stop trying fallback URLs
			break
		else
			echo "Failed to download from $url. Trying next source if available..."
			# Clean up any partial fragments before trying the next URL
			rm -f "$TMP_DIR/$name.tar.xz" "$CACHE_DIR/$name.etag-new"
		fi
	done

	if [ $up_to_date -eq 1 ]; then
		echo "$name already installed and up-to-date."
		rm -f "$CACHE_DIR/$name.etag-new"
		return
	fi

	if [ $downloaded -eq 0 ]; then
		echo "Error: Failed to download $name from all available sources."
		return
	fi

	# Install downloaded application
	mkdir "$name.new"
	xzcat "$TMP_DIR/$name.tar.xz" | tar x -C "./$name.new"

	# Clean up
	rm -rf "./$name" "$TMP_DIR/$name.tar.xz"
	mv -T "./$name.new" "./$name"
	mv "$CACHE_DIR/$name.etag-new" "$CACHE_DIR/$name.etag"
	echo "$name installed."
}


install_spa() {
	urls_str="$1"
	name="$2"
	echo "Installing $name (spa) ..."
	
	cd "$WEBROOT_DIR" || return

	rm -rf "$name.new" "$CACHE_DIR/$name.etag-new"
	
	urls_spaced=$(echo "$urls_str" | tr ',' ' ')

	downloaded=0
	up_to_date=0

	for url in $urls_spaced; do
		if curl --silent --show-error \
			--etag-save "$CACHE_DIR/$name.etag-new" \
			--etag-compare "$CACHE_DIR/$name.etag" \
			--max-filesize ${MAXSIZE} \
			--retry 3 \
			--retry-delay 1 \
			-o "$TMP_DIR/$name.tar.lzma" \
			"$url"; then
			
			if [ ! -f "$TMP_DIR/$name.tar.lzma" ]; then
				up_to_date=1
			else
				downloaded=1
			fi
			break
		else
			echo "Failed to download from $url. Trying next source if available..."
			rm -f "$TMP_DIR/$name.tar.lzma" "$CACHE_DIR/$name.etag-new"
		fi
	done

	if [ $up_to_date -eq 1 ]; then
		echo "$name already installed and up-to-date."
		rm -f "$CACHE_DIR/$name.etag-new"
		return
	fi

	if [ $downloaded -eq 0 ]; then
		echo "Error: Failed to download $name from all available sources."
		return
	fi

	# Install downloaded application
	mkdir "$name.new"
	lzcat "$TMP_DIR/$name.tar.lzma" | tar x -C "./$name.new"

	# Clean up
	rm -rf "./$name" "$TMP_DIR/$name.tar.lzma"
	mv -T "./$name.new" "./$name"
	mv "$CACHE_DIR/$name.etag-new" "$CACHE_DIR/$name.etag"
	echo "$name installed."
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
