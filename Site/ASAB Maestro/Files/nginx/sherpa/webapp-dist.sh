#!/bin/sh

# Test by:
# $ ./gov.sh compose up nginx-1-webapp-dist

CACHE_DIR=/var/cache/nginx
WEBROOT_DIR=/webroot
TMP_DIR=/tmp

MAXSIZE=100M


install_mfe() {  # args: URL: $1, Name: $2
	echo "Installing $2 (mfe) ..."
	
	cd "$WEBROOT_DIR"

	rm -rf "$2.new" "$CACHE_DIR/$2.etag-new"
	
	# Download the web application from the provided URL
	curl -k --silent --show-error \
		--etag-save "$CACHE_DIR/$2.etag-new" \
		--etag-compare "$CACHE_DIR/$2.etag" \
		--max-filesize ${MAXSIZE} \
		--retry 10 \
		--retry-delay 0 \
		-o "$TMP_DIR/$2.tar.xz" \
		"$1"

	if [ $? -ne 0 ]
	then
		echo "Failed to download $1"
		return
	fi

	if [ ! -f "$TMP_DIR/$2.tar.xz" ]; then
		# This happens then ETag check indicates no change in of the previously downloaded distribution
		echo "$2 already installed and up-to-date."
		rm "$CACHE_DIR/$2.etag-new"
		return
	fi

	# Install downloaded application
	mkdir "$2.new"
	xzcat "$TMP_DIR/$2.tar.xz" | tar x -C "./$2.new"

	# Clean um
	rm -rf "./$2" "$TMP_DIR/$2.tar.xz"
	mv -T "./$2.new" "./$2"
	mv "$CACHE_DIR/$2.etag-new" "$CACHE_DIR/$2.etag"
	echo "$2 installed."
}


install_spa() {  # args: URL: $1, Name: $2
	echo "Installing $2 (spa) ..."
	
	cd "$WEBROOT_DIR"

	rm -rf "$2.new" "$CACHE_DIR/$2.etag-new"
	
	# Download the web application from the provided URL
	curl -k --silent --show-error \
		--etag-save "$CACHE_DIR/$2.etag-new" \
		--etag-compare "$CACHE_DIR/$2.etag" \
		--max-filesize ${MAXSIZE} \
		--retry 10 \
		--retry-delay 0 \
		-o "$TMP_DIR/$2.tar.lzma" \
		"$1"

	if [ $? -ne 0 ]
	then
		echo "Failed to download $1"
		return
	fi

	if [ ! -f "$TMP_DIR/$2.tar.lzma" ]; then
		# This happens then ETag check indicates no change in of the previously downloaded distribution
		echo "$2 already installed and up-to-date."
		rm "$CACHE_DIR/$2.etag-new"
		return
	fi

	# Install downloaded application
	mkdir "$2.new"
	lzcat "$TMP_DIR/$2.tar.lzma" | tar x -C "./$2.new"

	# Clean um
	rm -rf "./$2" "$TMP_DIR/$2.tar.lzma"
	mv -T "./$2.new" "./$2"
	mv "$CACHE_DIR/$2.etag-new" "$CACHE_DIR/$2.etag"
	echo "$2 installed."
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
